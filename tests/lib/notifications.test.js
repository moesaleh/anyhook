const { formatSlackPayload, formatEmailBody } = require('../../src/lib/notifications');

describe('formatSlackPayload', () => {
  it('produces a text + blocks payload', () => {
    const out = formatSlackPayload({
      subscriptionId: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
      webhookUrl: 'https://hooks.example.com/in',
      eventId: '11111111-1111-1111-1111-111111111111',
      organizationName: 'Acme Inc',
    });
    expect(out.text).toContain('aaaaaaaa');
    expect(out.blocks).toHaveLength(1);
    expect(out.blocks[0].type).toBe('section');
    expect(out.blocks[0].text.type).toBe('mrkdwn');
    expect(out.blocks[0].text.text).toContain('Subscription:');
    expect(out.blocks[0].text.text).toContain('Webhook URL:');
    expect(out.blocks[0].text.text).toContain('Acme Inc');
  });

  it('omits the organization line when not provided', () => {
    const out = formatSlackPayload({
      subscriptionId: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
      webhookUrl: 'https://hooks.example.com/in',
      eventId: '11111111-1111-1111-1111-111111111111',
    });
    expect(out.blocks[0].text.text).not.toContain('Organization:');
  });
});

describe('formatEmailBody', () => {
  it('includes the subscription id, webhook url, and event id', () => {
    const out = formatEmailBody({
      subscriptionId: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
      webhookUrl: 'https://hooks.example.com/in',
      eventId: '11111111-1111-1111-1111-111111111111',
      organizationName: 'Acme Inc',
    });
    expect(out).toContain('aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee');
    expect(out).toContain('https://hooks.example.com/in');
    expect(out).toContain('11111111-1111-1111-1111-111111111111');
    expect(out).toContain('Organization: Acme Inc');
  });

  it('omits the Organization line when not provided', () => {
    const out = formatEmailBody({
      subscriptionId: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
      webhookUrl: 'https://hooks.example.com/in',
      eventId: '11111111-1111-1111-1111-111111111111',
    });
    expect(out).not.toContain('Organization:');
  });
});
