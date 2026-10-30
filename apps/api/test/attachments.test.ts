import { existsSync } from 'node:fs';
import { utimes, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { Readable } from 'node:stream';
import { describe, expect, it } from 'vitest';
import { env } from '../src/env';
import { prisma } from '../src/lib/prisma';
import { DiskStorage } from '../src/lib/storage';
import { PENDING_UPLOAD_TTL_MS, resolveMimeType, sweepUploads } from '../src/modules/attachments.service';
import { signedInAgent, workspaceWithMember } from './helpers';

type Agent = Awaited<ReturnType<typeof signedInAgent>>['agent'];

const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(64, 7)]);

function upload(agent: Agent, channelId: string, body: Buffer, name = 'photo.png', type = 'image/png') {
  return agent
    .post(`/api/channels/${channelId}/attachments`)
    .query({ name, type })
    .set('Content-Type', 'application/octet-stream')
    .send(body);
}

/** Reads any response body as raw bytes. */
function download(agent: Agent, url: string) {
  return agent
    .get(url)
    .buffer(true)
    .parse((res, done) => {
      const chunks: Buffer[] = [];
      res.on('data', (c: Buffer) => chunks.push(c));
      res.on('end', () => done(null, Buffer.concat(chunks)));
    });
}

const filePath = async (attachmentId: string) => {
  const { storageKey } = await prisma.attachment.findUniqueOrThrow({ where: { id: attachmentId } });
  return path.join(path.resolve(env.UPLOAD_DIR), storageKey);
};

describe('uploading', () => {
  it('stores a verified image, sends it with a message and serves it inline to channel members', async () => {
    const { owner, member, generalId } = await workspaceWithMember();

    const up = await upload(owner.agent, generalId, PNG);
    expect(up.status).toBe(201);
    expect(up.body.attachment).toMatchObject({
      name: 'photo.png',
      mimeType: 'image/png',
      size: PNG.length,
      isImage: true,
    });

    const sent = await owner.agent
      .post(`/api/channels/${generalId}/messages`)
      .send({ content: '', attachmentIds: [up.body.attachment.id] });
    expect(sent.status).toBe(201);
    expect(sent.body.message.attachments).toEqual([up.body.attachment]);

    const file = await download(member.agent, up.body.attachment.url);
    expect(file.status).toBe(200);
    expect(file.headers['content-type']).toBe('image/png');
    expect(file.headers['content-disposition']).toMatch(/^inline;/);
    expect(file.headers['content-security-policy']).toContain('sandbox');
    expect(Buffer.compare(file.body as Buffer, PNG)).toBe(0);

    // History includes the attachment too.
    const history = await member.agent.get(`/api/channels/${generalId}/messages`);
    expect(history.body.items.at(-1).attachments).toHaveLength(1);
  });

  it('serves anything that is not a verified image as a download', async () => {
    const { owner, generalId } = await workspaceWithMember();

    const html = Buffer.from('<script>alert(1)</script>');
    const fake = await upload(owner.agent, generalId, html, 'cat.png', 'image/png');
    expect(fake.body.attachment).toMatchObject({ mimeType: 'application/octet-stream', isImage: false });

    const pdf = await upload(
      owner.agent,
      generalId,
      Buffer.from('%PDF-1.7 ...'),
      'Teklif ödemesi.pdf',
      'application/pdf',
    );
    expect(pdf.body.attachment).toMatchObject({
      name: 'Teklif ödemesi.pdf',
      mimeType: 'application/pdf',
      isImage: false,
    });

    const res = await download(owner.agent, pdf.body.attachment.url);
    expect(res.headers['content-type']).toBe('application/octet-stream');
    expect(res.headers['content-disposition']).toContain('attachment;');
    expect(res.headers['content-disposition']).toContain("filename*=UTF-8''Teklif%20%C3%B6demesi.pdf");
  });

  it('refuses form, text and JSON bodies so a cross-site form cannot upload', async () => {
    const { owner, generalId } = await workspaceWithMember();
    for (const type of ['multipart/form-data; boundary=x', 'text/plain', 'application/x-www-form-urlencoded']) {
      const res = await owner.agent
        .post(`/api/channels/${generalId}/attachments`)
        .query({ name: 'a.txt' })
        .set('Content-Type', type)
        .send('hello');
      expect(res.status).toBe(415);
    }
    const json = await owner.agent.post(`/api/channels/${generalId}/attachments?name=a.json`).send({ a: 1 });
    expect(json.status).toBe(415);
  });

  it('requires channel membership and a non-empty file', async () => {
    const { owner, workspace } = await workspaceWithMember();
    const outsider = await signedInAgent('Outsider');
    const { body } = await owner.agent.post(`/api/workspaces/${workspace.id}/channels`).send({ name: 'random' });
    const randomId = body.channel.id as string;

    expect((await upload(outsider.agent, randomId, PNG)).status).toBe(404);
    // A workspace member who has not joined the public channel can see it but not post to it.
    const member = await signedInAgent('Viewer');
    await member.agent.post('/api/workspaces/join').send({ inviteCode: workspace.inviteCode });
    expect((await upload(member.agent, randomId, PNG)).status).toBe(403);

    expect((await upload(owner.agent, randomId, Buffer.alloc(0))).status).toBe(400);
  });

  it('stops writing at the size limit and leaves no file behind', async () => {
    const dir = path.join(path.resolve(env.UPLOAD_DIR), 'limit-test');
    const disk = new DiskStorage(dir);
    await expect(disk.put('big', Readable.from([Buffer.alloc(600), Buffer.alloc(600)]), 1000)).rejects.toMatchObject({
      status: 413,
    });
    expect(await disk.list()).toEqual([]);
  });

  it('only trusts image types whose bytes match', () => {
    expect(resolveMimeType('image/png', PNG)).toBe('image/png');
    expect(resolveMimeType('image/jpeg', PNG)).toBe('application/octet-stream');
    expect(resolveMimeType('image/svg+xml', Buffer.from('<svg/>'))).toBe('image/svg+xml');
    expect(resolveMimeType('not a type', PNG)).toBe('application/octet-stream');
    expect(resolveMimeType(undefined, PNG)).toBe('application/octet-stream');
  });
});

describe('sending files', () => {
  it('keeps pending uploads private and attaches each one only once, by its uploader', async () => {
    const { owner, member, generalId } = await workspaceWithMember();
    const up = await upload(owner.agent, generalId, PNG);
    const id = up.body.attachment.id as string;

    expect((await download(member.agent, up.body.attachment.url)).status).toBe(404);
    expect((await download(owner.agent, up.body.attachment.url)).status).toBe(200);

    const stolen = await member.agent.post(`/api/channels/${generalId}/messages`).send({ attachmentIds: [id] });
    expect(stolen.status).toBe(400);

    expect((await owner.agent.post(`/api/channels/${generalId}/messages`).send({ attachmentIds: [id] })).status).toBe(
      201,
    );
    const again = await owner.agent.post(`/api/channels/${generalId}/messages`).send({ attachmentIds: [id] });
    expect(again.status).toBe(400);

    const empty = await owner.agent.post(`/api/channels/${generalId}/messages`).send({ content: '   ' });
    expect(empty.status).toBe(400);
  });

  it('hides files from people who lose access and deletes them with their message', async () => {
    const { owner, generalId } = await workspaceWithMember();
    const outsider = await signedInAgent('Outsider');
    const up = await upload(owner.agent, generalId, PNG);
    const sent = await owner.agent
      .post(`/api/channels/${generalId}/messages`)
      .send({ attachmentIds: [up.body.attachment.id] });

    expect((await download(outsider.agent, up.body.attachment.url)).status).toBe(404);

    const stored = await filePath(up.body.attachment.id);
    expect(existsSync(stored)).toBe(true);
    await owner.agent.delete(`/api/messages/${sent.body.message.id}`).expect(204);
    expect(existsSync(stored)).toBe(false);
    expect((await download(owner.agent, up.body.attachment.url)).status).toBe(404);
  });

  it('sweeps unsent uploads and files that lost their row, but not recent ones', async () => {
    const { owner, generalId } = await workspaceWithMember();
    const stale = await upload(owner.agent, generalId, PNG);
    const fresh = await upload(owner.agent, generalId, PNG);
    const old = new Date(Date.now() - PENDING_UPLOAD_TTL_MS - 60_000);

    await prisma.attachment.update({ where: { id: stale.body.attachment.id }, data: { createdAt: old } });
    const staleFile = await filePath(stale.body.attachment.id);
    await utimes(staleFile, old, old);
    const orphan = path.join(path.resolve(env.UPLOAD_DIR), 'a1b2c3d4-orphan');
    await writeFile(orphan, 'left behind');
    await utimes(orphan, old, old);

    const result = await sweepUploads();
    expect(result.pendingRemoved).toBeGreaterThanOrEqual(1);
    expect(existsSync(staleFile)).toBe(false);
    expect(existsSync(orphan)).toBe(false);
    expect(existsSync(await filePath(fresh.body.attachment.id))).toBe(true);
    expect(await prisma.attachment.findUnique({ where: { id: stale.body.attachment.id } })).toBeNull();
  });
});
