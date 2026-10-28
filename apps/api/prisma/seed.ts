import bcrypt from 'bcryptjs';
import { prisma } from '../src/lib/prisma';

const PASSWORD = 'demo1234';
const USERS = [
  { email: 'demo@whoischat.dev', name: 'Demo User' },
  { email: 'ayse@convo.dev', name: 'Ayşe Yılmaz' },
  { email: 'mert@convo.dev', name: 'Mert Demir' },
  { email: 'elif@convo.dev', name: 'Elif Kaya' },
];

// [channel, author index, message]
const SCRIPT: [string, number, string][] = [
  ['general', 1, 'Günaydın herkese ☀️'],
  ['general', 2, 'Standup 10 dk sonra, link takvimde'],
  ['general', 0, 'Kahve alıp geliyorum, 2 dk gecikebilirim'],
  ['general', 3, 'Design review perşembe 14:00’e kaydı bu arada'],
  ['engineering', 2, 'Login sayfasındaki redirect bug’ı için PR açtım, bakabilir misiniz?'],
  ['engineering', 0, 'Öğleden önce bakarım'],
  ['engineering', 1, 'Staging’e dünkü build çıktı, bir şey patlarsa haber verin'],
  ['engineering', 2, 'Safari’de sidebar hâlâ biraz kayıyor, issue açtım'],
  ['engineering', 0, 'PR’a iki yorum bıraktım, gerisi tamam 👍'],
  ['design', 3, 'Yeni sidebar mockup’ları Figma’da, yorumlarınızı bekliyorum'],
  ['design', 1, 'Unread badge’ler çok iyi olmuş. Accent rengi biraz daha yumuşak olabilir mi?'],
  ['design', 3, 'Olur, iki alternatif deneyeyim'],
  ['leadership', 1, 'Q4 işe alım planı taslağı hazır, dokümana ekledim'],
  ['leadership', 0, 'Teşekkürler, akşam okuyorum'],
  ['general', 1, 'Öğlen ne yiyoruz? Pide mi döner mi 🤔'],
  ['general', 2, 'Pide, tartışmaya kapalı'],
];

async function main() {
  await prisma.user.deleteMany({ where: { email: { in: USERS.map((u) => u.email) } } });
  await prisma.workspace.deleteMany({ where: { slug: 'convo-demo' } });

  const passwordHash = await bcrypt.hash(PASSWORD, 12);
  const users = [];
  for (const u of USERS) users.push(await prisma.user.create({ data: { ...u, passwordHash } }));
  const [demo, ayse, mert, elif] = users as [
    (typeof users)[0],
    (typeof users)[0],
    (typeof users)[0],
    (typeof users)[0],
  ];

  const workspace = await prisma.workspace.create({
    data: {
      name: 'Convo Demo',
      slug: 'convo-demo',
      inviteCode: 'convo-demo-invite',
      members: {
        create: [
          { userId: demo.id, role: 'OWNER' },
          { userId: ayse.id, role: 'ADMIN' },
          { userId: mert.id },
          { userId: elif.id },
        ],
      },
    },
  });

  const channelDefs = [
    { name: 'general', topic: 'Company-wide announcements and chat', members: users },
    { name: 'engineering', topic: 'Backend, frontend and infrastructure', members: [demo, ayse, mert] },
    { name: 'design', topic: 'UI, UX and brand', members: [demo, ayse, elif] },
    { name: 'leadership', topic: 'Planning and hiring', members: [demo, ayse], isPrivate: true },
  ];
  const channels = new Map<string, string>();
  for (const def of channelDefs) {
    const channel = await prisma.channel.create({
      data: {
        workspaceId: workspace.id,
        name: def.name,
        topic: def.topic,
        isPrivate: def.isPrivate ?? false,
        createdById: demo.id,
        members: { create: def.members.map((m) => ({ userId: m.id, joinedAt: new Date(Date.now() - 86_400_000) })) },
      },
    });
    channels.set(def.name, channel.id);
  }

  // Spread messages over the last few hours, oldest first.
  const start = Date.now() - SCRIPT.length * 7 * 60_000;
  for (const [i, [channel, author, content]] of SCRIPT.entries()) {
    await prisma.message.create({
      data: {
        channelId: channels.get(channel)!,
        authorId: users[author]!.id,
        content,
        createdAt: new Date(start + i * 7 * 60_000),
      },
    });
  }

  // The demo user has read #general up to the lunch question, so the last message shows as unread.
  const lunch = await prisma.message.findFirstOrThrow({ where: { content: { startsWith: 'Öğlen' } } });
  await prisma.channelMember.update({
    where: { channelId_userId: { channelId: channels.get('general')!, userId: demo.id } },
    data: { lastReadAt: lunch.createdAt, lastReadMessageId: lunch.id },
  });

  console.log(`Seeded workspace "${workspace.name}". Sign in with demo@whoischat.dev / ${PASSWORD}`);
  console.log(
    `Other users: ${USERS.slice(1)
      .map((u) => u.email)
      .join(', ')} (same password)`,
  );
}

main()
  .catch((err) => {
    console.error(err);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
