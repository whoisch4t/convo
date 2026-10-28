import { expect, test, type Browser, type Page } from '@playwright/test';

const password = 'password123';
const uniqueEmail = (who: string) => `${who}-${Date.now()}-${Math.random().toString(36).slice(2, 7)}@example.com`;

async function register(browser: Browser, name: string) {
  const context = await browser.newContext();
  const page = await context.newPage();
  await page.goto('/register');
  await page.getByLabel('Name').fill(name);
  await page.getByLabel('Email').fill(uniqueEmail(name.toLowerCase()));
  await page.getByLabel('Password').fill(password);
  await page.getByRole('button', { name: 'Create account' }).click();
  await expect(page).toHaveURL(/\/workspaces$/);
  return page;
}

async function connected(page: Page) {
  await expect(page.getByRole('status').filter({ hasText: 'Connected' })).toBeVisible();
}

test('redirects signed-out visitors to the login page', async ({ page }) => {
  await page.goto('/workspaces');
  await expect(page).toHaveURL(/\/login\?next=%2Fworkspaces/);
  await expect(page.getByRole('heading', { name: 'Sign in to Convo' })).toBeVisible();
});

test('two people chat in real time', async ({ browser }) => {
  // Alice creates a workspace.
  const alice = await register(browser, 'Alice');
  await alice.getByLabel('Workspace name').fill('Playwright Inc');
  await alice.getByRole('button', { name: 'Create workspace' }).click();
  await expect(alice.getByRole('heading', { name: 'general' })).toBeVisible();
  await connected(alice);

  // Read the invite code from the invite dialog.
  await alice.getByRole('button', { name: 'Invite people' }).click();
  const inviteCode = await alice.getByLabel('Invite code').inputValue();
  await alice.keyboard.press('Escape');

  // Bob joins with the code and lands in #general.
  const bob = await register(browser, 'Bob');
  await bob.getByRole('tab', { name: 'Join with code' }).click();
  await bob.getByLabel('Invite code').fill(inviteCode);
  await bob.getByRole('button', { name: 'Join workspace' }).click();
  await expect(bob.getByRole('heading', { name: 'general' })).toBeVisible();
  await connected(bob);

  // Presence: Alice sees Bob come online.
  await expect(alice.getByText('People · 2 online')).toBeVisible();

  // Typing indicator, then the message itself.
  await bob.getByLabel('Message #general').pressSequentially('Hi Al');
  await expect(alice.getByText('Bob is typing…')).toBeVisible();
  await bob.getByLabel('Message #general').pressSequentially('ice!');
  await bob.getByLabel('Message #general').press('Enter');
  await expect(alice.getByRole('log').getByText('Hi Alice!')).toBeVisible();
  await expect(alice.getByText('Bob is typing…')).toBeHidden();

  // Read receipt: Bob sees that Alice has seen his message.
  await expect(bob.getByTestId('seen-by')).toHaveText('Seen by Alice');

  // Unread badge: Alice creates #random; Bob joins it and posts while Alice is in #general.
  await alice.getByRole('button', { name: 'Create channel' }).click();
  await alice.getByLabel('Name').fill('random');
  await alice.getByRole('button', { name: 'Create', exact: true }).click();
  await expect(alice.getByRole('heading', { name: 'random' })).toBeVisible();
  await alice.getByRole('link', { name: 'general' }).click();

  await bob.getByRole('link', { name: 'random' }).click();
  await bob.getByRole('button', { name: 'Join channel' }).click();
  await bob.getByLabel('Message #random').fill('Anyone here?');
  await bob.getByLabel('Message #random').press('Enter');
  await expect(alice.getByRole('link', { name: /random/ }).getByLabel('1 unread')).toBeVisible();

  // Edits propagate live.
  await bob.getByRole('log').getByText('Anyone here?').hover();
  await bob.getByRole('button', { name: 'Edit message' }).click();
  await bob.getByLabel('Edit message').fill('Anyone around?');
  await bob.getByLabel('Edit message').press('Enter');
  await alice.getByRole('link', { name: /random/ }).click();
  await expect(alice.getByRole('log').getByText('Anyone around?')).toBeVisible();
  await expect(alice.getByRole('log').getByText('(edited)')).toBeVisible();

  // Search finds it.
  await alice.getByRole('button', { name: 'Search messages' }).click();
  await alice.getByLabel('Search').fill('around');
  await expect(alice.getByRole('dialog').getByText('Bob')).toBeVisible();

  // Bob closes the app: Alice sees him go offline.
  await bob.context().close();
  await alice.keyboard.press('Escape');
  await expect(alice.getByText('People · 1 online')).toBeVisible({ timeout: 10_000 });
});
