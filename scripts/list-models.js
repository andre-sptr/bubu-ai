require('dotenv').config();
const axios = require('axios');

async function main() {
  if (!process.env.SUMOPOD_API_KEY) throw new Error('SUMOPOD_API_KEY is required');
  const base = (process.env.SUMOPOD_BASE_URL || 'https://ai.sumopod.com/v1').replace(/\/+$/, '');
  const response = await axios.get(`${base}/models`, {
    headers: { Authorization: `Bearer ${process.env.SUMOPOD_API_KEY}` },
    timeout: 30000
  });
  const models = response.data?.data || [];
  for (const model of models) console.log(model.id || model.name || JSON.stringify(model));
  console.log(`\nTotal: ${models.length} models`);
}
main().catch((error) => {
  console.error(error.response?.status, error.response?.data || error.message);
  process.exit(1);
});
