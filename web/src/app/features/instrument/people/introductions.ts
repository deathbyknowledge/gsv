import type { ActorRef, ContactSendArgs, ContactSummary, ConversationMessage, PublicProfile } from "@humansandmachines/gsv/protocol";

export type IntroductionPlan =
  | { kind: "request"; source: ContactSummary; subject: ActorRef; label: string }
  | { kind: "offer"; person: ContactSummary }
  | { kind: "forward"; recipient: ContactSummary; consent: ConversationMessage };
export type IntroductionPart = { recipient: ContactSummary; title: string; args: ContactSendArgs };
export type IntroductionReview = { parts: IntroductionPart[] };
export type IntroductionInput = { plan: IntroductionPlan; selected?: ContactSummary; name: string; recipientName: string; context: string; consentConfirmed: boolean; profile?: PublicProfile };

export function isIntroductionConsent(message: ConversationMessage, recipient: ContactSummary): boolean {
  return message.conversationId === recipient.conversationId && message.author.kind === "contact"
    && message.author.shipId === recipient.remoteShipId && message.author.subjectId === recipient.remoteSubject.id
    && !!message.text.trim() && (message.social?.provenance.kind === "human" || message.social?.provenance.kind === "approved");
}

export function introductionReview(input: IntroductionInput): IntroductionReview {
  const { plan } = input;
  const name = input.name.trim();
  const note = input.context.trim();
  if (!name || name.length > 80 || note.length > 4000) throw new Error("Add a name to share and keep the note under 4,000 characters.");
  if (plan.kind === "request") return { parts: [part(plan.source, "Request an introduction", `Could you introduce me to ${name}?\n\n${note || "I'd like to speak with them, if they're interested."}\n\nPlease ask them first and agree what may be shared.\n\nPerson mentioned in your shared context:\n${plan.subject.shipId} / ${plan.subject.subjectId}`)] };
  if (!input.selected || input.selected.state !== "active") throw new Error("Choose an active conversation.");
  if (plan.kind === "offer") {
    if (input.selected.id === plan.person.id) throw new Error("Choose a different recipient.");
    return { parts: [part(input.selected, "Ask before introducing", `Would you like an introduction to ${name}?\n\n${note || "I thought you might like to meet."}\n\nIf you're interested, please tell me what name and contact details I may share with them. I'll agree the details with both of you before making the introduction.`)] };
  }
  const person = input.selected;
  if (person.id === plan.recipient.id || !isIntroductionConsent(plan.consent, plan.recipient) || !input.consentConfirmed) throw new Error("Review the recipient's response and confirm the agreed disclosure first.");
  const recipientName = input.recipientName.trim();
  if (!recipientName || recipientName.length > 80) throw new Error("Choose the recipient's agreed name for the other conversation.");
  if (input.profile && (input.profile.actor.shipId !== person.remoteShipId || input.profile.actor.subjectId !== person.remoteSubject.id || input.profile.origin !== person.remoteOrigin)) throw new Error("The public profile belongs to a different person.");
  const link = input.profile ? `\n\nTheir published profile: ${input.profile.url}` : "\n\nYou can reply here to arrange a public profile or a private invitation.";
  const recipient = part(plan.recipient, `Introduce ${name}`, `As agreed, I'd like to introduce ${name}.\n\n${note || "I thought the two of you would enjoy speaking."}${link}\n\nYou can each decide whether and how to continue.`);
  recipient.args.replyTo = plan.consent.social!.reference;
  const introduced = part(person, `Let ${name} know`, `${recipientName} has agreed to an introduction.\n\n${note || "I thought the two of you would enjoy speaking."}\n\nYou can reply here with the public profile or private invitation you'd like me to pass on. You each choose whether to continue.`);
  return { parts: [recipient, introduced] };
}

function part(recipient: ContactSummary, title: string, text: string): IntroductionPart {
  if (recipient.state !== "active") throw new Error("This conversation has ended.");
  return { recipient, title, args: { contactId: recipient.id, expectedGeneration: recipient.generation, text, idempotencyKey: crypto.randomUUID() } };
}
