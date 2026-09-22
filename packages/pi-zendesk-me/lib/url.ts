// Ticket reference parsing. The agent (and Esteban) habitually copy full
// agent-UI URLs like https://{subdomain}.zendesk.com/agent/tickets/7942 - accept
// those directly instead of forcing id extraction by hand.

/** Accepts a numeric id, or any URL containing /tickets/<digits>. */
export function parseTicketRef(input: string): number | null {
  const trimmed = input.trim();
  if (/^\d+$/.test(trimmed)) return Number(trimmed);
  const match = trimmed.match(/\/tickets\/(\d+)/);
  return match ? Number(match[1]) : null;
}

/** View/filter ref: bare id, /agent/filters/<id>, or /views/<id>. */
export function parseViewRef(input: string): number | null {
  const trimmed = input.trim();
  if (/^\d+$/.test(trimmed)) return Number(trimmed);
  const match = trimmed.match(/\/(?:filters|views)\/(\d+)/);
  return match ? Number(match[1]) : null;
}

export const TICKET_REF_EXAMPLE =
  'a numeric ticket id ("7942") or a full agent URL ' +
  '("https://{subdomain}.zendesk.com/agent/tickets/7942")';

export const VIEW_REF_EXAMPLE =
  'a numeric view id ("20824934716439") or a full agent URL ' +
  '("https://{subdomain}.zendesk.com/agent/filters/20824934716439")';
