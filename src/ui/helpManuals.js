// #3762 (the flower, 3/5; part of #3759): the pages behind the "?" leaf. They are not written
// again here: each page is a list of entries of docs/assistant-handbook.md, and what is shown for an
// entry is its question, its numbered steps and what you will see, word for word. So the "?" pages
// and what an assistant says from the handbook cannot disagree, and the handbook's own test (the
// controls it names are on the real screen) keeps both true. "If something goes wrong" is left out:
// it speaks to the assistant (hand-offs, what to read back), not to the person.
import { SECTION_SEE, SECTION_WRONG } from '../../scripts/assistant-handbook-lib.mjs';

// The order a person meets them in. A title here must be an entry of the handbook; the unit test
// fails when one is renamed or removed without this list being updated.
export const MANUALS = [
  {
    id: 'move',
    title: 'How to move',
    entries: [
      'How do I walk around and look around?',
      'How do I fly, go up and come back down?',
      'How do I go between Shop, Build and Sell?',
      'How do I get back to where I was?',
    ],
  },
  {
    id: 'works',
    title: 'How higglehaven works',
    entries: ['What is higglehaven, and what can I do here?'],
  },
  {
    id: 'shopping',
    title: 'Shopping',
    entries: [
      'How do I look at a product and read about it?',
      'How do I buy something?',
      'How do I gather several things in a basket?',
      'How do I keep a shipping address?',
      'Where are the things I bought, and how do I rate a seller?',
      'How do I leave a review for a product?',
      'What are the glowing orbs, and what if I hit the limit?',
    ],
  },
  {
    id: 'building',
    title: 'Building',
    entries: [
      'How do I get my own lándlet?',
      'How do I add an item to my lándlet?',
      'How do I move an item?',
      'How do I turn an item?',
      'How do I copy an item?',
      'How do I remove an item, or get it back?',
      'How do I undo a mistake, or redo it?',
      'How do I select several items at once?',
      'How do I make a bundle, and use it again?',
      'How do I build up or dig down to another level?',
      'How do I measure something?',
    ],
  },
  {
    id: 'selling',
    title: 'Selling',
    entries: [
      'What does Sell mode show, and where is my showroom?',
      'How do I put my own product up for sale?',
      'How do I sell a product someone else already made?',
      'How do I find, change the price of, or rename one of my products?',
      'How do I take a product off sale, and what do buyers keep?',
      'Where do I set up payouts and tax forms?',
      'Where do I see what I have sold, and mark something shipped?',
    ],
  },
];

// The plain words of a handbook line: no markdown marks.
const plain = (text) => String(text || '').replace(/\*\*|`/g, '').replace(/\s+/g, ' ').trim();

// An entry as a person reads it: the question, the steps (each a plain sentence), what you will see.
// `entry` is one item of parseHandbook(); the controls block and the trouble-shooting part are left out.
export function readEntry(entry) {
  const lines = entry.prose;
  const seeAt = lines.findIndex((line) => line.includes(SECTION_SEE));
  const wrongAt = lines.findIndex((line) => line.includes(SECTION_WRONG));
  const stepLines = lines.slice(0, seeAt === -1 ? lines.length : seeAt);
  const steps = [];
  for (const line of stepLines) {
    if (/^\d+\.\s+\S/.test(line)) steps.push(line.replace(/^\d+\.\s+/, ''));
    else if (steps.length && line.trim()) steps[steps.length - 1] += ` ${line.trim()}`;
  }
  const seeLines = seeAt === -1 ? [] : lines.slice(seeAt, wrongAt === -1 ? lines.length : wrongAt);
  const see = plain(seeLines.join(' ').replace(SECTION_SEE, ''));
  return { title: entry.title, steps: steps.map(plain), see };
}

// The five pages, from the parsed handbook. An entry the handbook no longer has is simply not shown
// (and the unit test names it), so a rename can never leave a blank row on screen.
export function buildManuals(entries) {
  const byTitle = new Map(entries.map((entry) => [entry.title, entry]));
  return MANUALS.map((manual) => ({
    id: manual.id,
    title: manual.title,
    entries: manual.entries.filter((title) => byTitle.has(title)).map((title) => readEntry(byTitle.get(title))),
  }));
}
