#!/usr/bin/env node
/**
 * Alter partition counts on existing AnyHook Kafka topics.
 *
 * Usage:
 *   node scripts/alter-kafka-partitions.js              # dry run — print current state
 *   node scripts/alter-kafka-partitions.js --apply      # actually alter
 *   KAFKA_PARTITIONS=16 node scripts/alter-kafka-partitions.js --apply
 *
 * Why this script exists:
 *   admin.createTopics is a no-op for topics that already exist, so bumping
 *   KAFKA_PARTITIONS in .env doesn't affect a deployed cluster. This script
 *   uses admin.createPartitions to grow each topic to the new target.
 *
 * Constraints:
 *   - Kafka does NOT allow DECREASING partition count. The script bails
 *     loudly on that case rather than silently no-op'ing.
 *   - Re-partitioning changes the destination of new messages keyed by
 *     subscription_id (hash modulo partition count changes), so messages
 *     in flight at the time of alter may briefly land on a different
 *     consumer than messages for the same key sent immediately before.
 *     For our consumers (subscription-connector, webhook-dispatcher) this
 *     is benign — handlers are idempotent at the operation level.
 */

require('dotenv').config({ path: './.env' });
process.env.KAFKAJS_NO_PARTITIONER_WARNING = '1';
const { Kafka, logLevel } = require('kafkajs');

const TOPICS = [
  'subscription_events',
  'unsubscribe_events',
  'connection_events',
  'update_events',
  'dlq_events',
];

function parseBrokers(envValue) {
  return (envValue || 'localhost:9092').split(',').map((s) => s.trim()).filter(Boolean);
}

async function main() {
  const apply = process.argv.includes('--apply');
  const target = parseInt(process.env.KAFKA_PARTITIONS, 10) || 8;

  const kafka = new Kafka({
    clientId: 'anyhook-alter-partitions',
    brokers: parseBrokers(process.env.KAFKA_HOST),
    logLevel: logLevel.WARN,
  });
  const admin = kafka.admin();
  await admin.connect();

  let exitCode = 0;
  try {
    const metadata = await admin.fetchTopicMetadata({ topics: TOPICS }).catch((err) => {
      // fetchTopicMetadata throws if any requested topic doesn't exist.
      // Fall back to listing-then-checking so missing topics print a
      // useful message instead of a stack trace.
      console.error('fetchTopicMetadata failed:', err.message);
      return null;
    });

    const existing = new Map();
    if (metadata) {
      for (const t of metadata.topics) {
        existing.set(t.name, t.partitions.length);
      }
    } else {
      const allTopics = new Set(await admin.listTopics());
      for (const t of TOPICS) {
        if (allTopics.has(t)) {
          // best-effort per-topic fetch
          try {
            const m = await admin.fetchTopicMetadata({ topics: [t] });
            existing.set(t, m.topics[0].partitions.length);
          } catch {
            existing.set(t, null);
          }
        }
      }
    }

    console.log(`Target partitions: ${target}`);
    console.log(`Mode: ${apply ? 'APPLY' : 'DRY RUN'}\n`);
    console.log('Topic                         Current   Target   Action');
    console.log('---------------------------   -------   ------   ------');

    const toAlter = [];
    for (const topic of TOPICS) {
      const current = existing.has(topic) ? existing.get(topic) : null;
      let action;
      if (current === null) {
        action = 'MISSING (run subscription-management to create)';
      } else if (current === undefined) {
        action = 'NOT FOUND';
      } else if (current === target) {
        action = 'no change';
      } else if (current > target) {
        action = `REFUSED (cannot decrease ${current} → ${target})`;
        exitCode = 1;
      } else {
        action = `would grow ${current} → ${target}`;
        toAlter.push({ topic, count: target });
      }
      console.log(
        `${topic.padEnd(29)} ${String(current ?? '-').padStart(7)}   ${String(target).padStart(6)}   ${action}`
      );
    }

    if (toAlter.length === 0) {
      console.log('\nNothing to do.');
      return;
    }

    if (!apply) {
      console.log('\nDry run — pass --apply to actually alter.');
      return;
    }

    console.log('\nAltering...');
    await admin.createPartitions({
      topicPartitions: toAlter,
      validateOnly: false,
    });
    console.log('Done.');
  } catch (err) {
    console.error('Alter failed:', err.message);
    exitCode = 1;
  } finally {
    await admin.disconnect();
  }
  process.exit(exitCode);
}

main();
