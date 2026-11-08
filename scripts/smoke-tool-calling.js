require('dotenv').config();
const axios = require('axios');

async function main() {
  const base = (process.env.SUMOPOD_BASE_URL || 'https://ai.sumopod.com/v1').replace(/\/+$/, '');
  const key = process.env.SUMOPOD_API_KEY;
  const model = process.argv[2] || process.env.MODEL_BALANCED;
  if (!key || !model) throw new Error('Set SUMOPOD_API_KEY and pass a model ID (or MODEL_BALANCED)');
  const response = await axios.post(`${base}/chat/completions`, {
    model,
    temperature: 0,
    messages: [
      { role: 'system', content: 'Call the supplied function exactly once. Do not answer in text.' },
      { role: 'user', content: 'Save the note: tool calling works.' }
    ],
    tools: [{
      type: 'function',
      function: {
        name: 'smoke_test',
        description: 'A test function used only to verify tool calling support.',
        parameters: {
          type: 'object',
          properties: { note: { type: 'string' } },
          required: ['note'],
          additionalProperties: false
        }
      }
    }],
    tool_choice: 'required'
  }, {
    headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
    timeout: 60000
  });
  const message = response.data?.choices?.[0]?.message;
  if (!message?.tool_calls?.length) {
    console.error('FAIL: model did not return tool_calls.');
    console.log(JSON.stringify(message || response.data, null, 2));
    process.exitCode = 2;
    return;
  }
  console.log(`PASS: ${model} returned ${message.tool_calls.length} tool call(s).`);
  console.log(JSON.stringify(message.tool_calls, null, 2));
}
main().catch((error) => {
  console.error(error.response?.status, error.response?.data || error.message);
  process.exit(1);
});
