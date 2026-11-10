import { describe, expect, it } from 'vitest';
import { guarded } from '../src/tool-error';

describe('guarded', () => {
  it('passes a successful result straight through', async () => {
    const handler = guarded(async () => ({ content: [{ type: 'text' as const, text: 'ok' }] }));
    await expect(handler()).resolves.toEqual({ content: [{ type: 'text', text: 'ok' }] });
  });

  it('returns the failure as an isError result instead of throwing', async () => {
    const handler = guarded(async () => {
      throw new Error('mesh POST /agent/messages failed 403: mesh policy: …');
    });
    const res = await handler();
    expect(res.isError).toBe(true);
    expect(res.content[0]!.text).toContain('failed 403: mesh policy');
  });

  it('stringifies a non-Error throw', async () => {
    const handler = guarded(async () => {
      throw 'boom';
    });
    await expect(handler()).resolves.toMatchObject({ isError: true });
  });

  it('forwards the handler arguments', async () => {
    const handler = guarded(async (name: string) => ({
      content: [{ type: 'text' as const, text: `hi ${name}` }],
    }));
    await expect(handler('bob')).resolves.toMatchObject({
      content: [{ type: 'text', text: 'hi bob' }],
    });
  });
});
