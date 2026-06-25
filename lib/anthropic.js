const Anthropic = require('@anthropic-ai/sdk');

let client;
function getClient() {
  if (!client) {
    client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  }
  return client;
}

/**
 * @param {string} systemPrompt
 * @param {Array<{role: 'user'|'assistant', content: string}>} conversation
 * @returns {Promise<string>} texto crudo de la respuesta (incluye el bloque ###DATA###)
 */
async function generarRespuesta(systemPrompt, conversation) {
  const anthropic = getClient();
  const response = await anthropic.messages.create({
    model: process.env.CLAUDE_MODEL || 'claude-sonnet-4-6',
    max_tokens: 1024,
    system: systemPrompt,
    messages: conversation,
    tools: [{ type: 'web_search_20250305', name: 'web_search' }],
  });

  // Si Claude usó web_search, puede haber múltiples bloques — juntar todos los text
  const textos = response.content
    .filter(b => b.type === 'text')
    .map(b => b.text)
    .join('');

  return textos || '';
}

module.exports = { generarRespuesta };
