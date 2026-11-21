// Fixed test sentences, so every model can be compared on the same input.

export const SAMPLES: { label: string; text: string }[] = [
  { label: "Short", text: "Hello there! How are you doing today?" },
  {
    label: "Paragraph",
    text:
      "The quick brown fox jumps over the lazy dog. A good voice should sound natural, keep a steady pace, " +
      "and pause in the right places, even when a sentence runs on for a little while before it finally ends.",
  },
  {
    label: "Numbers & dates",
    text: "On March 3rd, 2025, the invoice for $1,249.50 was paid. Call 555-0142 before 9:30 AM, or after 6 PM.",
  },
  {
    label: "Acronyms & names",
    text: "The CPU and GPU in this laptop run an LLM and a TTS model. NASA, the BBC and Dr. Smith agreed with Mr. Nguyen.",
  },
  {
    label: "Questions & emotion",
    text: "Wait, you did what? That's incredible! Are you sure it works, or is this just another one of your jokes?",
  },
  {
    label: "Tongue twister",
    text: "She sells seashells by the seashore, and the shells she sells are surely seashells.",
  },
  {
    label: "Agent reply",
    text:
      "I found three issues in the build. First, a missing dependency. Second, an outdated lockfile. " +
      "Third, a failing test in the parser. I've fixed the first two and I'm now working on the test.",
  },
];
