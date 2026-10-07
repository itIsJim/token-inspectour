// Every turn resends the whole conversation. Runs five turns of one conversation and prints the
// input tokens of each call; the inspector's Session view charts the same growth.
import { send, usageLine } from './common.mjs';

const questions = [
  'Name one sorting algorithm.',
  'What is its average time complexity?',
  'Name a case where it performs badly.',
  'Suggest an alternative for that case.',
  'Summarise the previous four answers in one line.',
];
const session = `turns-${Date.now().toString(36)}`;
const messages = [];
for (const [i, q] of questions.entries()) {
  messages.push({ role: 'user', content: q });
  const r = await send({ system: 'Answer in one short sentence.', messages }, session);
  const text = r.content.filter((b) => b.type === 'text').map((b) => b.text).join('');
  messages.push({ role: 'assistant', content: text });
  console.log(usageLine(`turn ${i + 1}`, r.usage), '  ', text.slice(0, 60));
}
