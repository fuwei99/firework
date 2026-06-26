import dotenv from 'dotenv';
dotenv.config();

const apiKeys = (process.env.KEY || '').split(',').map(k => k.trim()).filter(Boolean);

async function checkAll() {
  if (apiKeys.length === 0) {
    console.log('No keys configured in .env file.');
    return;
  }

  console.log(`Checking accounts for ${apiKeys.length} key(s)...`);
  for (let i = 0; i < apiKeys.length; i++) {
    const key = apiKeys[i];
    const masked = key.slice(0, 6) + '...' + key.slice(-5);
    try {
      const res = await fetch('https://api.fireworks.ai/inference/v1/accounts', {
        headers: {
          'Authorization': `Bearer ${key}`
        }
      });
      if (res.status === 200) {
        const data = await res.json();
        console.log(`[Key ${i + 1}] ${masked}: ACTIVE - Account: ${data[0]?.displayName || 'Unknown'} (ID: ${data[0]?.id || 'Unknown'})`);
      } else {
        console.log(`[Key ${i + 1}] ${masked}: FAILED - HTTP Status ${res.status}`);
      }
    } catch (err) {
      console.log(`[Key ${i + 1}] ${masked}: ERROR - ${err.message}`);
    }
  }
}

checkAll();
