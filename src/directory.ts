import { malformedResponse } from "./errors.js";
import { isAci } from "./thread-id.js";
import type { SignalTransport } from "./transport/types.js";

/**
 * A `listContacts` entry (signal-cli 0.14.9 `JsonContact`), reduced to what the
 * adapter reads. `uuid` is the ACI, or null when signal-cli knows only a PNI.
 */
export interface SignalContact {
  number?: string | null;
  uuid?: string | null;
  name?: string | null;
  nickGivenName?: string | null;
  nickFamilyName?: string | null;
  profile?: { givenName?: string | null; familyName?: string | null } | null;
}

/** A `listGroups` entry (signal-cli 0.14.9 `JsonGroup`); `id` is standard base64, member `uuid`s are ACIs. */
export interface SignalGroup {
  id: string;
  name?: string | null;
  description?: string | null;
  members?: Array<{ uuid?: string | null } | null> | null;
}

/** A contact signal-cli knows the ACI of. */
type AciContact = SignalContact & { uuid: string };

/**
 * The contact signal-cli resolves `recipient` (an ACI, a phone number, or
 * `u:<username>`) to, or `undefined` when it knows no ACI for it. signal-cli
 * looks up numbers and usernames it has not seen yet on the Signal server.
 */
export async function findContact(
  transport: SignalTransport,
  account: string,
  recipient: string,
): Promise<AciContact | undefined> {
  const contacts = await listOf<SignalContact>(transport, "listContacts", {
    account,
    recipient: [recipient],
    allRecipients: true,
  });
  return contacts.find((contact): contact is AciContact => isAci(contact.uuid));
}

/** The Group with this standard-base64 ID, or `undefined` when the Bot Account does not know it. */
export async function findGroup(transport: SignalTransport, account: string, groupId: string): Promise<SignalGroup | undefined> {
  const groups = await listOf<SignalGroup>(transport, "listGroups", { account, groupId: [groupId] });
  return groups.find((group) => group.id === groupId);
}

/**
 * The name signal-cli puts in an envelope's `sourceName` (`getContactOrProfileName`):
 * the nickname, else the contact name, else the profile name; then the number, then the ACI.
 */
export function contactDisplayName(contact: AciContact): string {
  return (
    joinName(contact.nickGivenName, contact.nickFamilyName) ||
    contact.name ||
    joinName(contact.profile?.givenName, contact.profile?.familyName) ||
    contact.number ||
    contact.uuid
  );
}

function joinName(given: string | null | undefined, family: string | null | undefined): string {
  return [given, family].filter(Boolean).join(" ");
}

async function listOf<T>(transport: SignalTransport, method: string, params: Record<string, unknown>): Promise<T[]> {
  const entries = await transport.request<unknown>(method, params);
  if (!Array.isArray(entries) || entries.some((entry) => typeof entry !== "object" || entry === null)) {
    throw malformedResponse(method);
  }
  return entries as T[];
}
