import type { ClientInfo } from '@cloudflare/workers-oauth-provider';
import { describe, expect, it, vi } from 'vitest';
import type { ClientRegistrationStore } from './client-registration';
import { slideClientRegistration } from './client-registration';

const STORED_CLIENT = { clientId: 'client-123' } as ClientInfo;

type UpdateClient = ClientRegistrationStore['updateClient'];

function storeSpy(implementation?: UpdateClient) {
  return {
    updateClient: vi.fn<UpdateClient>(
      implementation ?? (async () => STORED_CLIENT),
    ),
  };
}

describe('slideClientRegistration', () => {
  it('re-puts the client record so a registration in use outlives its TTL', async () => {
    const provider = storeSpy();

    await slideClientRegistration(provider, 'client-123');

    expect(provider.updateClient).toHaveBeenCalledWith('client-123', {});
  });

  // The stored secret is hashed. An update that carried one would be re-hashed and
  // the client could never authenticate again, so the empty update is the contract
  // here, not an incidental argument.
  it('sends no fields, so the stored secret and auth method are untouched', async () => {
    const provider = storeSpy();

    await slideClientRegistration(provider, 'client-123');

    const [, updates] = provider.updateClient.mock.calls[0];
    expect(Object.keys(updates as object)).toEqual([]);
  });

  it('leaves the exchange alone when the registration cannot be extended', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const provider = storeSpy(async () => {
      throw new Error('KV unavailable');
    });

    await expect(
      slideClientRegistration(provider, 'client-123'),
    ).resolves.toBeUndefined();
    expect(warn).toHaveBeenCalled();

    warn.mockRestore();
  });

  // A registration that expired between the token endpoint's lookup and this one
  // comes back null. There is nothing left to extend, and refusing the exchange
  // would disconnect the client this call exists to keep connected.
  it('lets the exchange through when the registration is already gone', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const provider = storeSpy(async () => null);

    await expect(
      slideClientRegistration(provider, 'client-123'),
    ).resolves.toBeUndefined();
    expect(warn).toHaveBeenCalled();

    warn.mockRestore();
  });

  it('does not write for a missing client id', async () => {
    const provider = storeSpy();

    await slideClientRegistration(provider, '');

    expect(provider.updateClient).not.toHaveBeenCalled();
  });
});
