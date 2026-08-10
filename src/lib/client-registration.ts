import type { OAuthHelpers } from '@cloudflare/workers-oauth-provider';

export type ClientRegistrationStore = Pick<OAuthHelpers, 'updateClient'>;

// The provider writes `client:<id>` with the registration TTL and never touches it
// again: the record is re-put only by /register and updateClient, not by using it.
// So a connection that refreshes every hour still loses its client record on the
// TTL, and the next refresh is answered with invalid_client "Client not found".
// The refresh token's own 30 days never get to matter.
//
// The TTL exists to collect DCR registrations that nobody ever used — /register is
// reachable without Access, so anyone can create them. Re-putting the record on a
// token exchange keeps that: a registration that is never exchanged is never
// touched, so it still expires on schedule. Only the ones in use survive.
//
// An empty update is deliberate. The provider carries the stored client forward
// field by field and only re-hashes a secret when the update carries one, so this
// re-put preserves the existing secret and auth method exactly.
//
// One consequence is worth stating. For a confidential client, /register answered
// with `client_secret_expires_at = registrationDate + TTL`, and nothing here
// revises that: the secret keeps working past the moment the server once
// advertised. The direction is the safe one — a client that honours the metadata
// re-registers on schedule, which is exactly today's behaviour — but a leaked
// secret no longer ages out on its own while the connection stays in use.
// Disconnecting from /connections is what ends it, and that path is unaffected.
export async function slideClientRegistration(
  provider: ClientRegistrationStore,
  clientId: string,
): Promise<void> {
  if (!clientId) return;
  try {
    // The provider looks the client up again, so a registration that expires
    // between the token endpoint's own lookup and this one is already gone and
    // comes back null. Nothing can be extended at that point; the connection was
    // within milliseconds of ending either way. Failing the exchange over it would
    // disconnect the client this call exists to keep connected, so it is logged
    // and the exchange proceeds.
    const updated = await provider.updateClient(clientId, {});
    if (!updated) {
      console.warn(
        'クライアント登録が見つからないため有効期限を延長できませんでした',
        clientId,
      );
    }
  } catch (cause) {
    // The token being exchanged is valid whether or not its registration was
    // extended, and failing the exchange would disconnect the client this call
    // exists to keep connected. Losing the extension only costs the connection
    // the time until the next refresh, which will try again.
    console.warn('クライアント登録の有効期限を延長できませんでした', cause);
  }
}
