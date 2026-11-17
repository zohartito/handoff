// Deliberately lexical: a question, preference or use of "also" alone is
// insufficient. Inspect the speaker's prose and retain the original input.
const action = /^(?:please\s+)?(?:add|address|apply|audit|build|capture|change|check|clean|collect|compare|consider|create|do|document|draft|draw|ensure|evaluate|export|file|finish|fix|generate|get|give|include|investigate|keep|list|look|make|move|open|organize|plan|prepare|print|produce|put|record|redo|refresh|remind|render|review|run|save|schedule|see|send|set|show|start|test|track|try|update|verify|write)\b/i;
const deliverable = /\b(?:chart|checklist|copy|diagram|document|directory|draft|export|file|folder|guide|list|map|note|overview|page|plan|prompt|report|schedule|script|section|sheet|summary|transcript|table|test|version|view)s?\b/i;

function speakerText(prompt: string): string {
  return prompt
    .replace(/<pasted_content\b[^>]*>[\s\S]*?(?:<\/pasted_content[^>]*>|$)/gi, " ")
    .replace(/^`{3}[^\n]*\n[\s\S]*?(?:^`{3}[^\n]*$|(?![\s\S]))/gm, " ")
    .replace(/^\s*>[^\n]*/gm, " ")
    .replace(/(?:https?:\/\/\S+)|(?:"[^"\n]*")|(?:“[^”\n]*”)/g, " ")
    .replace(/[’‘]/g, "'").trim();
}

export function isSideAsk(prompt: string, inFlight = true): boolean {
  const text = speakerText(prompt);
  if (!text || /^(?:<|\/\w|\[Request interrupted)/i.test(text)) return false;
  if (/^(?:please )?(?:don'?t|do not|never) (?!forget to)\b/i.test(text)) return false;
  if (/\b(?:don'?t forget to|remind me to)\s+\w/i.test(text)) return true;
  if (/\b(?:one more thing|another thing|separately|separate request|for the backlog)\b/i.test(text) &&
      /\b(?:can|could|please|should|want|need|add|create|fix|check|review|write|make|update)\b/i.test(text)) return true;

  // An affirmative add-on, including a noun phrase ("also the updated guide").
  for (const match of text.matchAll(/\b(?:also|in addition|while you're (?:there|at it)|on top of that|on a side note)\b[,\s]*(?:please\s+|(?:can|could) (?:you|we)\s+|let'?s\s+|maybe you should\s+|I (?:want|need) (?:you )?to\s+)?/gi)) {
    const before = text.slice(0, match.index).trimEnd();
    if (/\b(?:did|didn't|don't|not|could|would|it|they|I|we)$/i.test(before)) continue;
    const tail = text.slice(match.index! + match[0].length);
    if (action.test(tail) || /^(?:the |an? |some )?(?:full |updated |new |other |extra )/i.test(tail) && deliverable.test(tail.split(/[.!?\n]/)[0])) return true;
  }

  // A deferred action or extra output, whether the time cue comes first or last.
  if (/\b(?:later|after(?:wards)?|once|when|as soon as|next time)\b/i.test(text) &&
      (action.test(text) || /\b(?:tell|remind|send|give|show|update|reprint|revisit) (?:me|us|the|that|this)\b/i.test(text)) &&
      !/^(?:what|when|how|why|where|should I|do I)\b/i.test(text)) return true;
  if (/\b(?:as well|too)\s*[.!?]*(?:\s|$)/i.test(text) &&
      (action.test(text) || deliverable.test(text)) && !/\btoo\s+(?:much|many|long|short|big|small)\b/i.test(text)) return true;

  // Commitments sometimes appear as callbacks or separate acceptance checks.
  if (/^(?:yes|sure|okay|ok)[, ]+(?:but )?(?:after|once|when)\s+\S/i.test(text)) return true;
  if (/\b(?:check|look at|verify|make sure)\b[^.!?\n]{0,100}\b(?:background|agents?|jobs?|workers?)\b/i.test(text) &&
      /\b(?:fail(?:ed|ures?)?|finished|running|status|on track)\b/i.test(text)) return true;
  if (/\b(?:remember we|another (?:one|version)|for (?:today|tomorrow)|after (?:that|this)|and for the new)\b/i.test(text) &&
      deliverable.test(text) && /\b(?:do|put|make|build|update|send|give|create)\b/i.test(text)) return true;
  if (/\b(?:and then|while|once|also)\b[^.!?\n]{0,180}\b(?:give me|send me|update the|put that in|first make sure)\b/i.test(text)) return true;

  if (/\b(?:yes|sure|okay|ok)\s+(?:update|write|add|make|give|send|put)\b/i.test(text) && deliverable.test(text)) return true;

  // Another imperative in a compound turn, or a distinct requested artifact.
  const clauses = text.split(/(?:[.!?]\s+|\n+|\b(?:and then|and also|and please|and make sure|and for the)\s+)/i);
  if (clauses.slice(1).some(clause => action.test(clause) && deliverable.test(clause))) return true;
  if (!inFlight) return false;
  if (/\b(?:can|could) you\s+(?:also\s+)?(?:make|give|create|put|add|write|generate|send)\b/i.test(text) && deliverable.test(text)) return true;
  if (/\b(?:I want you to|we should|let'?s|I need you to)\s+/i.test(text)) {
    const rest = text.split(/\b(?:I want you to|we should|let'?s|I need you to)\s+/i).slice(1);
    if (rest.some(part => action.test(part) && deliverable.test(part))) return true;
  }
  return false;
}
