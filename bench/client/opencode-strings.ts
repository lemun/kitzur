// Byte-exact strings and error patterns of OpenCode 1.18.33 (@03e6717) and Kilo Code 7.8.1 (@7d977bc) for the
// HTTP OpenCode client (bench/client/opencode.ts). Extracted from the sources into
// upstream reference and upstream reference (reference implementation, §2.5, §3.1);
// the sha256 of each file is given, and test/bench/client-opencode.test.ts checks them.

/** agent/prompt/compaction.txt (630 bytes, trailing newline); sha256 552db0de0af1873a8acd4a631e2548345d4c43192de1d9be69c8feab4b41f80c */
export const COMPACTION_SYSTEM =
  "You are a context summarization agent. You are given a conversation between a user and an agent. Your goal is to produce a structured summary matching the format specified so another coding agent can continue the work.\n\nAlways follow the exact output structure requested by the user prompt. Keep every section, preserve exact file paths and identifiers when known, and prefer terse bullets over paragraphs.\n\nDo not continue the conversation. Do not respond to any questions in the conversation. Only output the structured summary in the exact format requested by the user prompt. Respond in the same language as the conversation.\n";
/** core/src/session/compaction.ts SUMMARY_TEMPLATE (1107 chars); sha256 f508afb34ee881f5d317eda1fa22dff19426c257377796dad5b97436f4436e6a */
export const SUMMARY_TEMPLATE =
  "Output exactly the Markdown structure shown inside <template> and keep the section order unchanged. Do not include the <template> tags in your response.\n<template>\n## Objective\n- [one or two brief sentences describing what the user is trying to accomplish]\n\n## Important Details\n- [constraints/preferences, decisions and why, important facts/assumptions, exact context needed to continue, or \"(none)\"]\n\n## Work State\n### Completed\n- [finished work, verified facts, or changes made; otherwise \"(none)\"]\n\n### Active\n- [current work, partial changes, or investigation state; otherwise \"(none)\"]\n\n### Blocked\n- [blockers, failing commands, or unknowns; otherwise \"(none)\"]\n\n## Next Move\n1. [immediate concrete action, or \"(none)\"]\n2. [next action if known, or \"(none)\"]\n\n## Relevant Files\n- [file or directory path: why it matters, or \"(none)\"]\n</template>\n\nRules:\n- Keep every section, even when empty.\n- Use terse bullets, not prose paragraphs.\n- Preserve exact file paths, symbols, commands, error strings, URLs, and identifiers when known.\n- Do not mention the summary process or that context was compacted.";
/** core/src/session/compaction.ts SUMMARY_UPDATE_INSTRUCTIONS (952 chars); sha256 f089eb74bde1fb476647bae165d276f4e214eb32b5515f0d86bda9a0f26b6c15 */
export const SUMMARY_UPDATE_INSTRUCTIONS =
  "The <prior-summary> summarizes everything that happened before the <conversation>. Construct a new summary that combines both. The <prior-summary> is discarded after this: anything you do not carry into the new summary is lost.\n\nWhen combining:\n- Carry forward objectives, constraints, user directives, decisions, and parallel workstreams from the <prior-summary> even when the <conversation> does not mention them. Drop only what is finished and no longer needed.\n- The <conversation> is more recent than the <prior-summary>. Where they conflict, the conversation wins: state the corrected fact and drop the old claim.\n- Add new progress, decisions, constraints, and context from the conversation.\n- Move completed work from \"Active\" to \"Completed\".\n- If a blocker has been resolved, update the summary to reflect that while keeping any details still needed to continue the work.\n- Update \"Objective\" and \"Next Move\" to reflect the current work state.";
/** agent/prompt/title.txt (2120 bytes); sha256 e7a6848eba328f28c7e870874cf0591e4edbaf90d7602ad8fdfe90601c6e656f */
export const TITLE_SYSTEM =
  "You are a title generator. You output ONLY a thread title. Nothing else.\n\n<task>\nGenerate a brief title that would help the user find this conversation later.\n\nFollow all rules in <rules>\nUse the <examples> so you know what a good title looks like.\nYour output must be:\n- A single line\n- ≤50 characters\n- No explanations\n</task>\n\n<rules>\n- you MUST use the same language as the user message you are summarizing\n- Title must be grammatically correct and read naturally - no word salad\n- Never include tool names in the title (e.g. \"read tool\", \"bash tool\", \"edit tool\")\n- Focus on the main topic or question the user needs to retrieve\n- Vary your phrasing - avoid repetitive patterns like always starting with \"Analyzing\"\n- When a file is mentioned, focus on WHAT the user wants to do WITH the file, not just that they shared it\n- Keep exact: technical terms, numbers, filenames, HTTP codes\n- Remove: the, this, my, a, an\n- Never assume tech stack\n- Never use tools\n- NEVER respond to questions, just generate a title for the conversation\n- The title should NEVER include \"summarizing\" or \"generating\" when generating a title\n- DO NOT SAY YOU CANNOT GENERATE A TITLE OR COMPLAIN ABOUT THE INPUT\n- Always output something meaningful, even if the input is minimal.\n- If the user message is short or conversational (e.g. \"hello\", \"lol\", \"what's up\", \"hey\"):\n  → create a title that reflects the user's tone or intent (such as Greeting, Quick check-in, Light chat, Intro message, etc.)\n</rules>\n\n<examples>\n\"debug 500 errors in production\" → Debugging production 500 errors\n\"refactor user service\" → Refactoring user service\n\"why is app.js failing\" → app.js failure investigation\n\"implement rate limiting\" → Rate limiting implementation\n\"how do I connect postgres to my API\" → Postgres API connection\n\"best practices for React hooks\" → React hooks best practices\n\"@src/auth.ts can you add refresh token support\" → Auth refresh token support\n\"@utils/parser.ts this is broken\" → Parser bug fix\n\"look at @config.json\" → Config review\n\"@App.tsx add dark mode toggle\" → Dark mode toggle in App\n</examples>\n";
/** message-v2.ts:232-237 compaction part on the wire; sha256 66f7888b3951addfb842b8b0e10b81d33e70aeaa8d93dbb1d00bffcb9337684b */
export const COMPACTION_MARKER =
  "What did we do so far?";
/** compaction.ts:527-531 (overflow=false); sha256 80a62c1aa08786982ccca7e60fa1d71e6e807bd4af669df041041c5ffb17b0a0 */
export const CONTINUE_PROACTIVE =
  "Continue if you have next steps, or stop and ask for clarification if you are unsure how to proceed.";
/** compaction.ts:527-531 (overflow=true, no replay); sha256 970617110c4b1ce1b55c31deac166b4a23eb84a5473f8fe8b29b93b906aecde1 */
export const CONTINUE_OVERFLOW =
  "The previous request exceeded the provider's size limit due to large media attachments. The conversation was compacted and media files were removed from context. If the user was asking about attached images or files, explain that the attachments were too large to process and suggest they try again with smaller or fewer files.\n\nContinue if you have next steps, or stop and ask for clarification if you are unsure how to proceed.";

/** The user text of the title request (session/prompt.ts:193-253), followed by the first user message. */
export const TITLE_USER_PREFIX = 'Generate a title for this conversation:\n';

/** First-compaction instruction (core/src/session/compaction.ts buildPrompt). */
export const NEW_SUMMARY_INSTRUCTION =
  'Create a new anchored summary from the conversation history in the <conversation> tags above so another coding agent can continue the work.';

/** buildPrompt(): the summarizer's user message. */
export function buildSummarizerPrompt(conversation: string, previousSummary: string | null): string {
  const conv = `Here is the conversation so far:\n\n<conversation>\n${conversation}\n</conversation>`;
  if (!previousSummary) return [conv, NEW_SUMMARY_INSTRUCTION, SUMMARY_TEMPLATE].join('\n\n');
  return [
    conv,
    `Here is the summary of the conversation before the <conversation> above:\n\n<prior-summary>\n${previousSummary}\n</prior-summary>`,
    SUMMARY_UPDATE_INSTRUCTIONS,
    SUMMARY_TEMPLATE,
  ].join('\n\n');
}

/** packages/llm/src/provider-error.ts context-overflow patterns (27, all /i), verbatim (errsim/oc_patterns.js). */
export const OVERFLOW_PATTERNS: readonly RegExp[] = [
  /prompt is too long/i,
  /request_too_large/i,
  /input is too long for requested model/i,
  /exceeds the context window/i,
  /exceeds (?:the )?(?:model'?s )?maximum context length(?: of [\d,]+ tokens?|\s*\([\d,]+\))/i,
  /input token count.*exceeds the maximum/i,
  /tokens in request more than max tokens allowed/i,
  /maximum prompt length is \d+/i,
  /reduce the length of the messages/i,
  /maximum context length is \d+ tokens/i,
  /exceeds (?:the )?maximum allowed input length of [\d,]+ tokens?/i,
  /input \(\d+ tokens\) is longer than the model'?s context length \(\d+ tokens\)/i,
  /exceeds the limit of \d+/i,
  /exceeds the available context size/i,
  /greater than the context length/i,
  /context window exceeds limit/i,
  /exceeded model token limit/i,
  /context[_ ]length[_ ]exceeded/i,
  /request entity too large/i,
  /context length is only \d+ tokens/i,
  /input length.*exceeds.*context length/i,
  /prompt too long; exceeded (?:max )?context length/i,
  /too large for model with \d+ maximum context length/i,
  /prompt has [\d,]+ tokens?, but the configured context size is [\d,]+ tokens?/i,
  /model_context_window_exceeded/i,
  /too many tokens/i,
  /token limit exceeded/i,
];

/** OpenCode's exclusions; Kilo adds the fourth (errsim/kilo_exclusions.js). */
export const OVERFLOW_EXCLUSIONS_OPENCODE: readonly RegExp[] = [/^(throttling error|service unavailable):/i, /rate limit/i, /too many requests/i];
export const OVERFLOW_EXCLUSIONS_KILO: readonly RegExp[] = [
  ...OVERFLOW_EXCLUSIONS_OPENCODE,
  /(?:too many tokens|token limit exceeded).*(?:wait|try again|retry after)/i,
];

/** retry.ts: an unknown (non-APIError) error is retried when its JSON matches this (no word boundaries). */
export const RETRYABLE_UNKNOWN = /429|500|502|503|504|524/;
