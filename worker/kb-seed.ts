import type { Env } from "./types";
import { addCorpusDoc } from "./corpus";

export const SEED_DOCS: { title: string; chunks: string[] }[] = [
  {
    title: "What AI chat tools actually do",
    chunks: [
      "An AI chat tool generates text by predicting what words are most likely to come next, based on patterns learned from very large amounts of text. It is not looking answers up in a database, and it has no live knowledge of your company unless you give it that context.",
      "Because the model predicts rather than retrieves, it can produce text that sounds confident but is wrong. Treat its output as a strong first draft from a well-read colleague, not as a verified source of record.",
    ],
  },
  {
    title: "Writing a good prompt",
    chunks: [
      "A useful prompt has three parts: context (who you are and what situation this is for), task (exactly what you want produced), and format (length, tone, structure). Example: 'I'm a project manager writing to a delayed vendor. Draft a firm but polite email, under 150 words, asking for a revised delivery date.'",
      "Vague prompts get vague answers. 'Make this better' gives the tool nothing to aim at; 'Make this shorter and remove jargon so a new hire can follow it' gives it a target. Specific instructions about audience and purpose improve results more than any clever phrasing.",
    ],
  },
  {
    title: "Hallucinations and how to catch them",
    chunks: [
      "A hallucination is when an AI tool states something false as if it were fact — an invented statistic, a citation to a paper that does not exist, or a confident wrong date. It happens because the model is completing a plausible-sounding pattern, not checking a source.",
      "Build a verification habit: any name, number, date, quote, or legal claim in AI output should be checked against a real source before you rely on it or send it onward. Asking the tool 'how confident are you, and what should I verify?' is a quick way to surface weak spots.",
    ],
  },
  {
    title: "Using company data safely",
    chunks: [
      "Never paste confidential information — customer records, credentials, unreleased financials, personal data — into a tool that has not been approved for that data. Check your organisation's AI policy before using real records.",
      "When you need help with sensitive material, anonymise first: replace names with roles ('Client A', 'our supplier'), round or fictionalise numbers, and strip identifiers. The tool can still help with structure and wording without ever seeing the real data.",
    ],
  },
  {
    title: "Good first tasks for AI at work",
    chunks: [
      "AI tools are strongest at transforming text you already have: summarising long documents, drafting emails and announcements, rewriting for a different audience, turning notes into an agenda, and brainstorming options. These tasks are low-risk because you review everything before it leaves your hands.",
      "Weak first tasks: asking for final facts, figures, or legal and medical conclusions. Use the tool to prepare and structure work in these areas, but keep a human expert responsible for the substance.",
    ],
  },
  {
    title: "Treat it like a conversation",
    chunks: [
      "The first answer is a starting point, not the end. Ask follow-ups: 'shorter', 'more formal', 'give me three alternatives', 'explain the second point'. Each turn keeps the earlier context, so you can steer instead of starting over.",
      "You can also ask the tool to critique its own output: 'what is weak about this draft?' or 'what did you assume?'. This often surfaces problems faster than re-reading it yourself.",
    ],
  },
];

// Idempotent: seeding twice is a no-op once any seed doc exists.
export async function seedCorpus(env: Env): Promise<{ seeded: boolean; count: number }> {
  const existing = await env.DB.prepare("SELECT COUNT(*) AS n FROM kb_docs WHERE origin = 'seed'").first<{
    n: number;
  }>();
  if ((existing?.n ?? 0) > 0) {
    return { seeded: false, count: 0 };
  }
  for (const doc of SEED_DOCS) {
    await addCorpusDoc(env, { title: doc.title, origin: "seed", createdBy: null, chunks: doc.chunks });
  }
  return { seeded: true, count: SEED_DOCS.length };
}
