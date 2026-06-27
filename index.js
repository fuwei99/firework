import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { Readable } from 'node:stream';
import { ProxyAgent } from 'undici';
import nodemailer from 'nodemailer';

const CONFIG_PATH = path.resolve('config.json');
const KEYS_PATH = path.resolve('keys.json');
const MODELS_PATH = path.resolve('models.json');

// Load models mapping config
let modelsMap = {};
function loadModelsMap() {
  try {
    if (fs.existsSync(MODELS_PATH)) {
      const parsed = JSON.parse(fs.readFileSync(MODELS_PATH, 'utf8'));
      // Transform new object style into old simple string map style for compatibility, 
      // while keeping the rich object config accessible.
      modelsMap = {};
      for (const [beautifulId, value] of Object.entries(parsed)) {
        if (value && typeof value === 'object' && value.id) {
          modelsMap[beautifulId] = value.id;
        } else {
          modelsMap[beautifulId] = value;
        }
      }
    }
  } catch (e) {
    console.error('[Models] Failed to parse models.json:', e.message);
  }
}
loadModelsMap();

// Memory store for config parameters loaded from config.json
let configData = {};
try {
  if (fs.existsSync(CONFIG_PATH)) {
    configData = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
  }
} catch (e) {
  console.error('[Config] Failed to parse config.json, using defaults:', e.message);
}

let TARGET_HOST = configData.TARGET_HOST || 'https://api.fireworks.ai';
let PORT = configData.PORT || 7860;

// Client authentication password
let clientPassword = configData.PASSWORD || '';

// Outbound Proxy
let proxyUrl = configData.OUTBOUND_PROXY || '';

// Rotation mode: round-robin or exhaustion
let mode = configData.KEY_MODE || 'round-robin';

// Running key tracker index
let currentIndex = 0;

// Spend Monitoring State
let isSuspended = false;
let currentSpendUsage = 0;
let maxAllowedSpend = typeof configData.MAX_ALLOWED_SPEND === 'number' ? configData.MAX_ALLOWED_SPEND : 5.5;
let emailSentStatus = false;
let notificationEmail = configData.NOTIFICATION_EMAIL || '';

// SMTP credentials
let smtpHost = configData.SMTP_HOST || '';
let smtpPort = parseInt(configData.SMTP_PORT || '465', 10);
let smtpSecure = configData.SMTP_SECURE !== false;
let smtpUser = configData.SMTP_USER || '';
let smtpPass = configData.SMTP_PASS || '';

// Load detailed key status from keys.json
let keysDetail = [];
function loadKeysDetail() {
  try {
    if (fs.existsSync(KEYS_PATH)) {
      keysDetail = JSON.parse(fs.readFileSync(KEYS_PATH, 'utf8'));
    } else {
      keysDetail = [];
    }
  } catch (e) {
    console.error('[Keys] Failed to parse keys.json:', e.message);
    keysDetail = [];
  }
}
loadKeysDetail();

// Dynamic keys array for rotation
let keys = keysDetail.map(kd => kd.key).filter(Boolean);

// Save keys back to keys.json
function saveKeysDetail() {
  try {
    fs.writeFileSync(KEYS_PATH, JSON.stringify(keysDetail, null, 2), 'utf8');
  } catch (err) {
    console.error('[Keys] Failed to save keys.json:', err.message);
  }
}

// Helper to save configurations to config.json (keys synced separately now)
function saveConfigToFile() {
  try {
    const configContent = {
      TARGET_HOST,
      PORT: parseInt(PORT, 10),
      PASSWORD: clientPassword,
      OUTBOUND_PROXY: proxyUrl,
      KEY_MODE: mode,
      NOTIFICATION_EMAIL: notificationEmail,
      MAX_ALLOWED_SPEND: maxAllowedSpend,
      SMTP_HOST: smtpHost,
      SMTP_PORT: smtpPort,
      SMTP_SECURE: smtpSecure,
      SMTP_USER: smtpUser,
      SMTP_PASS: smtpPass
    };
    fs.writeFileSync(CONFIG_PATH, JSON.stringify(configContent, null, 2), 'utf8');
    console.log(`[Config] Config written to config.json for persistence.`);
  } catch (err) {
    console.error(`[Config] Failed to save config to config.json:`, err.message);
  }
}

/**
 * Mask key for logging purposes.
 */
function maskKey(key) {
  if (!key || key.length <= 10) return '***';
  return `${key.slice(0, 6)}...${key.slice(-5)}`;
}

console.log(`[Init] Loaded ${keys.length} Fireworks API key(s) from keys.json.`);
keys.forEach((k, idx) => {
  console.log(`  Key [${idx + 1}]: ${maskKey(k)}`);
});

// Request logs memory store (capped at 200 items)
const requestLogs = [];
const MAX_LOGS = 200;

// Track which keys have already sent out alert emails so we don't spam.
// We only notify when a key goes over maxAllowedSpend for the first time.
const notifiedKeys = new Set();

// Notification and Suspend check functions
async function sendNotificationEmail(newlyExcessiveKey) {
  if (!notificationEmail) {
    console.warn('[SMTP] No notification email configured.');
    return;
  }

  const transporter = nodemailer.createTransport({
    host: smtpHost || 'smtp.qq.com',
    port: smtpPort,
    secure: smtpSecure,
    auth: {
      user: smtpUser || 'tokendance_agent@qq.com', 
      pass: smtpPass || 'test-smtp-code'
    }
  });

  // Filter out all currently suspended keys (spend >= maxAllowedSpend)
  const currentlySuspendedKeys = keysDetail.filter(kd => kd.total_used >= maxAllowedSpend);
  
  // Format for the currently triggered key
  const triggeredKeyInfo = `Key: ${maskKey(newlyExcessiveKey.key)}\nAccount ID: ${newlyExcessiveKey.account_id}\nEmail: ${newlyExcessiveKey.email}\nSpend: $${newlyExcessiveKey.total_used.toFixed(4)} USD\nLast Checked: ${newlyExcessiveKey.last_checked}`;

  const suspendedKeys = keysDetail.filter(kd => kd.total_used >= maxAllowedSpend);
  const suspendedListText = suspendedKeys.map(kd => {
    return `- Email/Account: ${kd.email || kd.account_id || maskKey(kd.key)} (Spend: $${kd.total_used.toFixed(4)} USD, Last Checked: ${kd.last_checked})`;
  }).join('\n');

  const suspendedListHtml = suspendedKeys.map(kd => {
    return `
    <div style="padding: 10px; border-bottom: 1px solid #eee;">
      <strong>Email/Account:</strong> ${kd.email || kd.account_id || maskKey(kd.key)}<br/>
      <strong>Spend:</strong> <span style="color: #ef4444; font-weight: bold;">$${kd.total_used.toFixed(4)} USD</span><br/>
      <strong>Last Checked:</strong> ${kd.last_checked}
    </div>`;
  }).join('');

  const mailOptions = {
    from: smtpUser,
    to: notificationEmail,
    subject: `🚨 Fireworks Key Spend Alert: ${newlyExcessiveKey.email || newlyExcessiveKey.account_id || maskKey(newlyExcessiveKey.key)}`,
    text: `${newlyExcessiveKey.email || newlyExcessiveKey.account_id || maskKey(newlyExcessiveKey.key)}在${newlyExcessiveKey.last_checked}时间时额度用量已经超过${maxAllowedSpend.toFixed(2)}刀，目前已经暂停使用，下面是他的详细信息：\n\n${triggeredKeyInfo}\n\n以下是目前暂停的邮箱和他们的详细信息：\n\n${suspendedListText}`,
    html: `
    <div style="font-family: Arial, sans-serif; line-height: 1.6; color: #333; max-width: 600px; margin: 0 auto; border: 1px solid #ddd; border-radius: 8px; overflow: hidden; box-shadow: 0 4px 6px rgba(0,0,0,0.05);">
      <div style="background-color: #ef4444; padding: 20px; text-align: center; color: white;">
        <h2 style="margin: 0; font-size: 20px; font-weight: bold;">Fireworks Key Spend Alert</h2>
      </div>
      <div style="padding: 25px; background-color: #fff;">
        <p style="font-size: 15px; margin-top: 0;">
          <strong>${newlyExcessiveKey.email || newlyExcessiveKey.account_id || maskKey(newlyExcessiveKey.key)}</strong> 在 <code>${newlyExcessiveKey.last_checked}</code> 时间时额度用量已经超过 <strong>${maxAllowedSpend.toFixed(2)} 刀</strong>，目前已经暂停使用，下面是他的详细信息：
        </p>
        <table style="width: 100%; border-collapse: collapse; margin: 20px 0; background-color: #f9fafb; border-radius: 6px; overflow: hidden;">
          <tr style="border-bottom: 1px solid #edf2f7;"><td style="padding: 12px; font-weight: bold; color: #4a5568; width: 120px;">Key:</td><td style="padding: 12px; font-family: monospace; color: #2d3748;">${maskKey(newlyExcessiveKey.key)}</td></tr>
          <tr style="border-bottom: 1px solid #edf2f7;"><td style="padding: 12px; font-weight: bold; color: #4a5568;">Account ID:</td><td style="padding: 12px; color: #2d3748;">${newlyExcessiveKey.account_id}</td></tr>
          <tr style="border-bottom: 1px solid #edf2f7;"><td style="padding: 12px; font-weight: bold; color: #4a5568;">Email:</td><td style="padding: 12px; color: #2d3748;">${newlyExcessiveKey.email}</td></tr>
          <tr style="border-bottom: 1px solid #edf2f7;"><td style="padding: 12px; font-weight: bold; color: #4a5568;">Spend:</td><td style="padding: 12px; font-size: 16px; color: #ef4444; font-weight: bold;">$${newlyExcessiveKey.total_used.toFixed(4)} USD</td></tr>
          <tr><td style="padding: 12px; font-weight: bold; color: #4a5568;">Last Checked:</td><td style="padding: 12px; color: #718096; font-size: 13px;">${newlyExcessiveKey.last_checked}</td></tr>
        </table>
        
        <div style="margin-top: 30px;">
          <h3 style="font-size: 16px; border-bottom: 2px solid #edf2f7; padding-bottom: 8px; color: #2d3748;">目前所有已暂停的账号清单</h3>
          ${suspendedListHtml}
        </div>
      </div>
      <div style="background-color: #f7fafc; padding: 15px; text-align: center; font-size: 12px; color: #a0aec0; border-top: 1px solid #edf2f7;">
        <p style="margin: 0;">This check runs automatically every 5 minutes.</p>
      </div>
    </div>`
  };

  try {
    if (smtpUser && smtpPass) {
      await transporter.sendMail(mailOptions);
      console.log(`[SMTP] Notification email successfully sent to ${notificationEmail}`);
    } else {
      console.log(`[SMTP Mock] Notification email trigger log (credentials not setup): ${JSON.stringify(mailOptions)}`);
    }
  } catch (err) {
    console.error('[SMTP] Failed to send email alert:', err.message);
  }
}

async function fetchAccountsAndSpend() {
  if (keys.length === 0) return;
  const dispatcher = getProxyDispatcher(proxyUrl);
  
  let totalUsage = 0;
  let hasValidCheck = false;

  // Calculate startTime (beginning of current month in UTC)
  const now = new Date();
  const startTime = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)).toISOString();
  const endTime = now.toISOString();

  for (let i = 0; i < keysDetail.length; i++) {
    const kd = keysDetail[i];
    const verifyOptions = {
      method: 'GET',
      headers: { 'Authorization': `Bearer ${kd.key}` }
    };
    if (dispatcher) {
      verifyOptions.dispatcher = dispatcher;
    }

    try {
      const resVerify = await fetch('https://api.fireworks.ai/v1/accounts', verifyOptions);
      if (resVerify.status === 200) {
        const responseData = await resVerify.json();
        const accountInfo = responseData.accounts?.[0];
        if (accountInfo) {
          const rawName = accountInfo.name || '';
          const accountId = rawName.split('/').pop() || '';
          
          if (accountId) {
            kd.account_id = accountId;
            kd.display_name = accountInfo.displayName || 'Fireworks User';
            kd.email = accountInfo.email || '';

            // Query serverless billingUsage for this account
            const billingUrl = `https://api.fireworks.ai/v1/accounts/${accountId}/billingUsage?startTime=${encodeURIComponent(startTime)}&endTime=${encodeURIComponent(endTime)}&usageType=SERVERLESS&groupBy=api_key_id&groupBy=api_key_name&groupBy=model_name`;
            const billingRes = await fetch(billingUrl, verifyOptions);
            
            if (billingRes.status === 200) {
              const billingData = await billingRes.json();
              const serverlessCosts = billingData.serverlessCosts || [];
              
              // Filter costs to only include usage from THIS specific key.
              // We match by key prefix or find the keyId from the API.
              // Let's list the API keys first or match the key prefix.
              let targetKeyId = null;
              try {
                // Fetch the list of API keys for this user to match keyId
                const userId = accountId; // Fireworks usually has user_id same as account_id or we can list users
                const keysListUrl = `https://api.fireworks.ai/v1/accounts/${accountId}/users/${userId}/apiKeys`;
                const keysListRes = await fetch(keysListUrl, verifyOptions);
                if (keysListRes.status === 200) {
                  const keysListData = await keysListRes.json();
                  const matchedKeyObj = (keysListData.apiKeys || []).find(k => kd.key.startsWith(k.prefix || ''));
                  if (matchedKeyObj) {
                    targetKeyId = matchedKeyObj.keyId;
                  }
                }
              } catch (keyErr) {
                console.error(`[Spend Check] Error retrieving keyId mapping for ${maskKey(kd.key)}:`, keyErr.message);
              }

              let calculatedSpend = 0;
              for (const costItem of serverlessCosts) {
                // If we successfully matched the keyId, filter by it.
                // Otherwise, fall back to checking if the item belongs to this account (since this is a single-key account usually, but filtering is safer).
                if (targetKeyId && costItem.apiKeyId !== targetKeyId) {
                  continue; 
                }

                const model = costItem.modelName || (costItem.group && costItem.group.model_name) || '';
                const promptTokens = parseInt(costItem.promptTokens || '0', 10);
                const completionTokens = parseInt(costItem.completionTokens || '0', 10);
                const cachedTokens = 0; // billingUsage does not separate cached tokens in response directly, we calculate with standard rate

                const itemCost = estimateCost(model, promptTokens, completionTokens, cachedTokens, false);
                calculatedSpend += itemCost;
              }

              kd.total_used = parseFloat(calculatedSpend.toFixed(6));
              kd.total_remaining = Math.max(0, 6.0 - kd.total_used);
              kd.status = 'Active';
              kd.last_checked = new Date().toISOString();

              totalUsage += kd.total_used;
              hasValidCheck = true;
            } else {
              kd.status = `Billing API Error ${billingRes.status}`;
              kd.last_checked = new Date().toISOString();
            }
          }
        }
      } else {
        kd.status = `HTTP Error ${resVerify.status}`;
        kd.last_checked = new Date().toISOString();
      }
    } catch (err) {
      kd.status = `Connection Error: ${err.message}`;
      kd.last_checked = new Date().toISOString();
    }
  }

  saveKeysDetail();

  if (hasValidCheck) {
    currentSpendUsage = totalUsage;
    console.log(`[Spend Check] Aggregate spend usage of all keys: $${totalUsage.toFixed(4)} USD (Limit: $${maxAllowedSpend.toFixed(2)} USD)`);

    // Detect keys that have newly exceeded maxAllowedSpend (dynamically loaded from config)
    for (const kd of keysDetail) {
      if (kd.total_used >= maxAllowedSpend) {
        if (!notifiedKeys.has(kd.key)) {
          notifiedKeys.add(kd.key);
          console.log(`[Spend Check] Key ${maskKey(kd.key)} newly exceeded the threshold ($${maxAllowedSpend}). Sending notification email.`);
          await sendNotificationEmail(kd);
        }
      } else {
        // If usage falls below threshold (e.g. new billing month or limit updated), clear the notification flag
        if (notifiedKeys.has(kd.key)) {
          notifiedKeys.delete(kd.key);
        }
      }
    }

    if (totalUsage >= maxAllowedSpend) {
      console.warn(`[Spend Check] Aggregate spend usage of all keys: $${totalUsage.toFixed(4)} USD (Limit: $${maxAllowedSpend.toFixed(2)} USD).`);
    }
  }
}

// Check spend every 5 minutes
setInterval(fetchAccountsAndSpend, 5 * 60 * 1000);
// Initial run after start
setTimeout(fetchAccountsAndSpend, 5000);

/**
 * Estimate cost for Fireworks AI models based on models.json pricing metadata
 * Returns price per 1M tokens or custom rates for text/vision models
 */
function estimateCost(model, promptTokens, completionTokens, cachedTokens = 0, isPriority = false) {
  if (!model) return 0;
  const modelLower = model.toLowerCase();

  let inputRate = 0.90;
  let cachedRate = null;
  let outputRate = 0.90;

  try {
    // Try to locate the model in models.json (loaded from MODELS_PATH)
    if (fs.existsSync(MODELS_PATH)) {
      const parsedModels = JSON.parse(fs.readFileSync(MODELS_PATH, 'utf8'));
      let foundConfig = null;

      // Match by exact key or clean key or target id
      const cleanModel = modelLower.replace(/^accounts\/fireworks\/models\//, '').replace(/^fireworks\//, '');
      
      for (const [beautifulId, config] of Object.entries(parsedModels)) {
        if (config && typeof config === 'object') {
          const configId = (config.id || '').toLowerCase();
          if (
            beautifulId.toLowerCase() === cleanModel || 
            configId.includes(modelLower) || 
            modelLower.includes(configId) ||
            (configId && cleanModel.includes(configId.replace(/^accounts\/fireworks\/models\//, '').replace(/^fireworks\//, '')))
          ) {
            foundConfig = config;
            break;
          }
        }
      }

      if (foundConfig) {
        inputRate = typeof foundConfig.input_price === 'number' ? foundConfig.input_price : inputRate;
        cachedRate = typeof foundConfig.cached_input_price === 'number' ? foundConfig.cached_input_price : cachedRate;
        outputRate = typeof foundConfig.output_price === 'number' ? foundConfig.output_price : outputRate;
        
        // Handle priority multiplier if applicable
        if (isPriority) {
          inputRate *= 1.5;
          if (cachedRate !== null) cachedRate *= 1.5;
          outputRate *= 1.5;
        }
      } else {
        // Fallbacks for general models
        if (modelLower.includes('moe')) {
          if (modelLower.includes('8x7b')) {
            inputRate = 0.50;
            outputRate = 0.50;
          } else {
            inputRate = 1.20;
            outputRate = 1.20;
          }
        } else {
          const paramMatch = modelLower.match(/(\d+)b/);
          if (paramMatch) {
            const size = parseInt(paramMatch[1], 10);
            if (size < 4) {
              inputRate = 0.10;
              outputRate = 0.10;
            } else if (size <= 16) {
              inputRate = 0.20;
              outputRate = 0.20;
            } else {
              inputRate = 0.90;
              outputRate = 0.90;
            }
          }
        }
      }
    }
  } catch (e) {
    console.error('[Cost Estimate] Error parsing models.json for pricing:', e.message);
  }

  if (cachedRate === null) {
    cachedRate = inputRate * 0.5;
  }

  const uncachedTokens = Math.max(0, promptTokens - cachedTokens);
  const cost = (uncachedTokens * inputRate + cachedTokens * cachedRate + completionTokens * outputRate) / 1000000;
  return parseFloat(cost.toFixed(6));
}

function addRequestLog(log) {
  log.cost = estimateCost(log.model, log.prompt_tokens, log.completion_tokens, log.cached_tokens, log.isPriority);
  requestLogs.unshift(log);
  if (requestLogs.length > MAX_LOGS) {
    requestLogs.pop();
  }
}

/**
 * Helper to get a ProxyAgent dispatcher if proxyUrl is set.
 */
function getProxyDispatcher(url) {
  if (!url) return undefined;
  try {
    return new ProxyAgent(url);
  } catch (err) {
    console.error(`[Proxy] Error creating ProxyAgent for "${url}":`, err.message);
    return undefined;
  }
}

/**
 * Read request body stream into a single Buffer.
 */
async function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', chunk => chunks.push(chunk));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', err => reject(err));
  });
}

/**
 * Helper to read JSON request body.
 */
async function readJsonBody(req) {
  const buffer = await readBody(req);
  if (!buffer || buffer.length === 0) return {};
  return JSON.parse(buffer.toString('utf8'));
}

/**
 * Proxies standard requests with round-robin or exhaustion retry mechanisms.
 */
async function handleProxyRequest(req, res, requestId) {
  const start = Date.now();
  
  if (keys.length === 0) {
    res.statusCode = 500;
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ error: { message: 'No API keys configured on proxy server.' } }));
    return;
  }

  // Check if keys are suspended due to spend limit (Keep check but it will only trigger if we manually set isSuspended)
  if (isSuspended) {
    res.statusCode = 503;
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({
      error: {
        message: `Service suspended. Monthly spend limit of $${maxAllowedSpend.toFixed(2)} USD exceeded. Current spend: $${currentSpendUsage.toFixed(4)} USD`,
        type: 'spend_limit_exceeded'
      }
    }));
    return;
  }

  // 1. Perform password check for proxy requests
  const authHeader = req.headers['authorization'];
  if (clientPassword) {
    const expectedBearer = `Bearer ${clientPassword}`;
    if (authHeader !== expectedBearer && authHeader !== clientPassword) {
      console.warn(`[${requestId}] Unauthorized request: ${req.method} ${req.url} (Invalid or missing PASSWORD)`);
      res.statusCode = 401;
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({
        error: {
          message: 'Unauthorized - Invalid or missing API key/password',
          type: 'invalid_request_error'
        }
      }));
      return;
    }
  }

  // 2. Buffer request body to support retries on failures
  let bodyBuffer = null;
  let bodyJson = null;
  let isPriority = false;
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    try {
      bodyBuffer = await readBody(req);
      const contentType = req.headers['content-type'] || '';
      if (contentType.includes('application/json') && bodyBuffer && bodyBuffer.length > 0) {
        try {
          bodyJson = JSON.parse(bodyBuffer.toString('utf8'));
          
          // Map beautiful model ID to fireworks real model ID if match exists
          if (bodyJson && bodyJson.model) {
            const requestedModel = bodyJson.model;
            // Support matching clean ID directly or matching with potential prefix like "fireworks/"
            const cleanKey = requestedModel.replace(/^accounts\/fireworks\/models\//, '').replace(/^fireworks\//, '');
            if (modelsMap[cleanKey]) {
              console.log(`[Model Map] Mapping beautiful ID "${requestedModel}" -> real ID "${modelsMap[cleanKey]}"`);
              bodyJson.model = modelsMap[cleanKey];
              // Re-serialize the body
              bodyBuffer = Buffer.from(JSON.stringify(bodyJson), 'utf8');
            }
          }

          if (bodyJson && bodyJson.service_tier === 'priority') {
            isPriority = true;
          }
        } catch (e) {
          // Ignore JSON
        }
      }
    } catch (err) {
      console.error(`[${requestId}] Error reading request body:`, err.message);
      res.statusCode = 400;
      res.end(JSON.stringify({ error: { message: 'Failed to read request body' } }));
      return;
    }
  }

  let attempts = 0;
  const maxAttempts = keys.length;

  while (attempts < maxAttempts) {
    const keyIndex = currentIndex;
    const selectedKey = keys[keyIndex];
    if (!selectedKey) {
      currentIndex = 0;
      attempts++;
      continue;
    }

    // Check if the current key has exceeded maxAllowedSpend
    const keyDetail = keysDetail.find(kd => kd.key === selectedKey);
    if (keyDetail && keyDetail.total_used >= maxAllowedSpend) {
      console.warn(`[${requestId}] Key [${keyIndex + 1}] has exceeded maxAllowedSpend ($${keyDetail.total_used.toFixed(4)} >= $${maxAllowedSpend.toFixed(2)}). Switching key...`);
      currentIndex = (currentIndex + 1) % keys.length;
      attempts++;
      continue;
    }

    const maskedKey = maskKey(selectedKey);
    console.log(`[${requestId}] Attempt ${attempts + 1} | Using Key [${keyIndex + 1}/${keys.length}]: ${maskedKey} | Mode: ${mode}`);
    
    const headers = {};
    for (const [name, value] of Object.entries(req.headers)) {
      if (name.toLowerCase() === 'host') continue;
      headers[name] = value;
    }
    headers['authorization'] = `Bearer ${selectedKey}`;
    if (bodyBuffer) {
      headers['content-length'] = bodyBuffer.length.toString();
    }
    
    // Fireworks 官方 API 路径在 /v1 前需要加 /inference 前缀
    // 例如：/v1/chat/completions -> /inference/v1/chat/completions
    // 但模型列表 /v1/models 在官方是 /v1/models（已在 HTTP 路由层直返，无需转发）
    const proxiedPath = req.url.startsWith('/inference/') || req.url === '/v1/models' || req.url.startsWith('/v1/models?')
      ? req.url
      : `/inference${req.url.startsWith('/') ? req.url : `/${req.url}`}`;
    const targetUrl = `${TARGET_HOST}${proxiedPath}`;
    const dispatcher = getProxyDispatcher(proxyUrl);
    
    try {
      const fetchOptions = {
        method: req.method,
        headers: headers,
        duplex: 'half',
      };
      
      if (bodyBuffer) {
        fetchOptions.body = bodyBuffer;
      }
      
      if (dispatcher) {
        fetchOptions.dispatcher = dispatcher;
      }
      
      const response = await fetch(targetUrl, fetchOptions);
      const isFailedKey = response.status === 429 || response.status === 402 || response.status === 401;
      
      if (isFailedKey && keys.length > 1) {
        console.warn(`[${requestId}] Key [${keyIndex + 1}] returned status ${response.status}. Switching key...`);
        currentIndex = (currentIndex + 1) % keys.length;
        attempts++;
        continue;
      }
      
      if (mode === 'round-robin') {
        currentIndex = (currentIndex + 1) % keys.length;
      }
      
      res.statusCode = response.status;
      res.statusMessage = response.statusText;
      
      for (const [name, value] of response.headers.entries()) {
        const lowerName = name.toLowerCase();
        if (lowerName === 'transfer-encoding' || lowerName === 'connection') {
          continue;
        }
        res.setHeader(name, value);
      }
      
      if (response.body) {
        let firstChunkTime = null;
        const chunks = [];
        const responseStream = Readable.fromWeb(response.body);
        
        responseStream.on('data', (chunk) => {
          if (!firstChunkTime) {
            firstChunkTime = Date.now();
          }
          chunks.push(chunk);
          res.write(chunk);
        });
        
        responseStream.on('end', () => {
          const duration = Date.now() - start;
          const ttft = firstChunkTime ? (firstChunkTime - start) : duration;
          console.log(`[${requestId}] Response completed | Status ${response.status} (${duration}ms)`);
          
          res.end();

          let prompt_tokens = parseInt(response.headers.get('fireworks-prompt-tokens'), 10) || 0;
          let cached_tokens = parseInt(response.headers.get('fireworks-cached-prompt-tokens'), 10) || 0;
          let completion_tokens = 0;
          let total_tokens = 0;
          
          try {
            const fullBody = Buffer.concat(chunks).toString('utf8');
            try {
              const resJson = JSON.parse(fullBody);
              if (resJson && resJson.usage) {
                if (!prompt_tokens) prompt_tokens = resJson.usage.prompt_tokens || 0;
                completion_tokens = resJson.usage.completion_tokens || 0;
                total_tokens = resJson.usage.total_tokens || 0;
                if (resJson.usage.prompt_tokens_details) {
                  cached_tokens = resJson.usage.prompt_tokens_details.cached_tokens || cached_tokens || 0;
                }
              }
            } catch (jsonErr) {
              const usageMatch = fullBody.match(/"usage"\s*:\s*\{\s*"prompt_tokens"\s*:\s*(\d+)\s*,\s*"completion_tokens"\s*:\s*(\d+)\s*,\s*"total_tokens"\s*:\s*(\d+)/);
              if (usageMatch) {
                if (!prompt_tokens) prompt_tokens = parseInt(usageMatch[1], 10);
                completion_tokens = parseInt(usageMatch[2], 10);
                total_tokens = parseInt(usageMatch[3], 10);
              } else {
                const promptMatch = fullBody.match(/"prompt_tokens"\s*:\s*(\d+)/);
                const completionMatch = fullBody.match(/"completion_tokens"\s*:\s*(\d+)/);
                const totalMatch = fullBody.match(/"total_tokens"\s*:\s*(\d+)/);
                if (promptMatch && !prompt_tokens) prompt_tokens = parseInt(promptMatch[1], 10);
                if (completionMatch) completion_tokens = parseInt(completionMatch[1], 10);
                if (totalMatch) total_tokens = parseInt(totalMatch[1], 10);
              }
              const cachedMatch = fullBody.match(/"cached_tokens"\s*:\s*(\d+)/);
              if (cachedMatch) {
                cached_tokens = parseInt(cachedMatch[1], 10);
              }
            }
          } catch (e) {
            // decode err
          }

          if (prompt_tokens && completion_tokens && !total_tokens) {
            total_tokens = prompt_tokens + completion_tokens;
          }

          addRequestLog({
            timestamp: new Date().toISOString(),
            model: (bodyJson && bodyJson.model) || 'unknown',
            prompt_tokens,
            completion_tokens,
            total_tokens,
            cached_tokens,
            ttft,
            duration,
            keyIndex: keyIndex + 1,
            maskedKey,
            isPriority
          });
        });
        
        responseStream.on('error', (err) => {
          console.error(`[${requestId}] Stream error:`, err.message);
          if (mode === 'exhaustion') {
            currentIndex = (currentIndex + 1) % keys.length;
          }
          if (!res.headersSent) {
            res.statusCode = 500;
            res.end(JSON.stringify({ error: 'Stream interrupted' }));
          }
        });
      } else {
        res.end();
        const duration = Date.now() - start;
        console.log(`[${requestId}] Response completed (no body) | Status ${response.status} (${duration}ms)`);
        
        addRequestLog({
          timestamp: new Date().toISOString(),
          model: (bodyJson && bodyJson.model) || 'unknown',
          prompt_tokens: 0,
          completion_tokens: 0,
          total_tokens: 0,
          cached_tokens: 0,
          ttft: duration,
          duration,
          keyIndex: keyIndex + 1,
          maskedKey,
          isPriority
        });
      }
      
      return;
      
    } catch (error) {
      console.error(`[${requestId}] Connection error on Key [${keyIndex + 1}]:`, error.message);
      
      if (keys.length > 1) {
        currentIndex = (currentIndex + 1) % keys.length;
        attempts++;
        continue;
      }
      
      const duration = Date.now() - start;
      if (!res.headersSent) {
        res.statusCode = 502;
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({
          error: {
            message: 'Bad Gateway - Connection error',
            details: error.message
          }
        }));
      }
      return;
    }
  }
  
  console.error(`[${requestId}] All ${keys.length} keys were exhausted/failed.`);
  res.statusCode = 429;
  res.setHeader('Content-Type', 'application/json');
  res.end(JSON.stringify({
    error: {
      message: 'All configured Fireworks API keys returned error status (401/402/429) or failed to connect.'
    }
  }));
}

// Create HTTP Server
const server = http.createServer(async (req, res) => {
  const requestId = Math.random().toString(36).substring(2, 9);
  const parsedUrl = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const pathname = parsedUrl.pathname;
  
  if (pathname === '/' || pathname === '/dashboard') {
    try {
      const dashboardPath = path.resolve('dashboard.html');
      const html = fs.readFileSync(dashboardPath, 'utf8');
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(html);
    } catch (err) {
      res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('Error loading dashboard.html');
    }
    return;
  }
  
  if (pathname === '/api/login' && req.method === 'POST') {
    try {
      const body = await readJsonBody(req);
      const isMatch = body.password === clientPassword;
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: isMatch }));
    } catch (err) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: false, error: err.message }));
    }
    return;
  }

  // Handle /v1/models endpoint
  if ((pathname === '/v1/models' || pathname === '/models') && req.method === 'GET') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    const modelList = Object.keys(modelsMap).map(modelId => ({
      id: modelId,
      object: 'model',
      created: 1718000000,
      owned_by: 'fireworks'
    }));
    res.end(JSON.stringify({
      object: 'list',
      data: modelList
    }));
    return;
  }

  function isAuthorized() {
    if (!clientPassword) return true;
    const authHeader = req.headers['authorization'];
    const expectedBearer = `Bearer ${clientPassword}`;
    return authHeader === expectedBearer || authHeader === clientPassword;
  }

  if (pathname === '/api/logs' && req.method === 'GET') {
    if (!isAuthorized()) {
      res.writeHead(401, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Unauthorized' }));
      return;
    }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(requestLogs));
    return;
  }

  if (pathname === '/api/logs/clear' && req.method === 'POST') {
    if (!isAuthorized()) {
      res.writeHead(401, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Unauthorized' }));
      return;
    }
    requestLogs.length = 0;
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ success: true }));
    return;
  }
  
  if (pathname === '/api/config' && req.method === 'GET') {
    if (!isAuthorized()) {
      res.writeHead(401, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Unauthorized' }));
      return;
    }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      keysDetail,
      currentIndex,
      mode,
      proxyUrl,
      hasPassword: !!clientPassword,
      isSuspended,
      currentSpendUsage,
      maxAllowedSpend,
      notificationEmail,
      smtpHost,
      smtpPort,
      smtpSecure,
      smtpUser,
      smtpPass
    }));
    return;
  }
  
  if (pathname === '/api/config' && req.method === 'POST') {
    if (!isAuthorized()) {
      res.writeHead(401, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Unauthorized' }));
      return;
    }
    try {
      const body = await readJsonBody(req);
      
      if (Array.isArray(body.keys)) {
        // Support saving simple key list, dynamically mapping/preserving existing details
        const incomingKeys = body.keys.map(k => k.trim()).filter(k => k.length > 0);
        keysDetail = incomingKeys.map(k => {
          const existing = keysDetail.find(kd => kd.key === k);
          return existing || {
            key: k,
            account_id: '',
            display_name: '',
            email: '',
            total_used: 0.0,
            total_remaining: 6.0,
            status: 'Pending Verification',
            last_checked: ''
          };
        });
        keys = incomingKeys;
        saveKeysDetail();
      }
      if (body.mode === 'round-robin' || body.mode === 'exhaustion') {
        mode = body.mode;
      }
      if (typeof body.proxyUrl === 'string') {
        proxyUrl = body.proxyUrl.trim();
      }
      if (typeof body.password === 'string') {
        clientPassword = body.password;
      }
      if (typeof body.notificationEmail === 'string') {
        notificationEmail = body.notificationEmail.trim();
      }
      if (typeof body.maxAllowedSpend === 'number') {
        maxAllowedSpend = body.maxAllowedSpend;
      }
      if (typeof body.smtpHost === 'string') smtpHost = body.smtpHost.trim();
      if (typeof body.smtpPort === 'number') smtpPort = body.smtpPort;
      if (typeof body.smtpSecure === 'boolean') smtpSecure = body.smtpSecure;
      if (typeof body.smtpUser === 'string') smtpUser = body.smtpUser.trim();
      if (typeof body.smtpPass === 'string') smtpPass = body.smtpPass.trim();
      
      if (currentIndex >= keys.length) {
        currentIndex = Math.max(0, keys.length - 1);
      }
      
      saveConfigToFile();
      fetchAccountsAndSpend();

      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: true }));
    } catch (err) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: false, error: err.message }));
    }
    return;
  }
  
  if (pathname === '/api/switch-key' && req.method === 'POST') {
    if (!isAuthorized()) {
      res.writeHead(401, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Unauthorized' }));
      return;
    }
    try {
      const body = await readJsonBody(req);
      const index = parseInt(body.index, 10);
      
      if (!isNaN(index) && index >= 0 && index < keys.length) {
        currentIndex = index;
        console.log(`[Config] Manually switched active key index to [${currentIndex + 1}/${keys.length}]`);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: true }));
      } else {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: false, error: 'Invalid key index' }));
      }
    } catch (err) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: false, error: err.message }));
    }
    return;
  }

  if (pathname === '/api/balances' && req.method === 'POST') {
    if (!isAuthorized()) {
      res.writeHead(401, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Unauthorized' }));
      return;
    }
    try {
      await fetchAccountsAndSpend();
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: true, balances: keysDetail }));
    } catch (err) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: false, error: err.message }));
    }
    return;
  }

  await handleProxyRequest(req, res, requestId);
});

server.listen(PORT, () => {
  console.log(`[Server] Fireworks AI Proxy is running at http://localhost:${PORT}`);
  console.log(`[Server] Proxying requests to ${TARGET_HOST}`);
});
