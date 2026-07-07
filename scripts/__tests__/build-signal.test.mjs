import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildSignal } from '../sync-from-brain.mjs';

test('buildSignal reads social_feed_posts', () => {
  const rows = [
    { id: 'instagram_1', platform: 'instagram', media_type: 'photo',
      title: 'HELLO', caption: 'hello', media_url: '/api/social-media/instagram_x.jpg',
      platform_url: 'https://instagram.com/p/1', published_at: '2026-07-01T00:00:00Z' },
  ];
  const query = (sql) => sql.includes('social_feed_posts') ? rows : [];
  const out = buildSignal(query);
  assert.equal(out.length, 1);
  assert.equal(out[0].type, 'photo');
  assert.equal(out[0].mediaUrl, '/api/social-media/instagram_x.jpg');
  assert.equal(out[0].url, 'https://instagram.com/p/1');
  assert.equal(out[0].date, '2026-07-01');
});

test('buildSignal falls back to content_history when new table empty', () => {
  const legacy = [
    { id: 'c1', platform: 'bluesky', media_type: 'text', caption: 'legacy',
      media_url: '', platform_url: 'https://bsky.app/x', published_at: '2026-05-01T00:00:00Z',
      youtube_title: null, instagram_post_type: null },
  ];
  const query = (sql) => sql.includes('social_feed_posts') ? [] : legacy;
  const out = buildSignal(query);
  assert.equal(out.length, 1);
  assert.equal(out[0].caption, 'legacy');
});
