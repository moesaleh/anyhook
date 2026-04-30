/**
 * Transactional outbox helper.
 *
 * The handler that's writing the subscription row passes its own
 * pg client (from a BEGIN-wrapped transaction) so the INSERT into
 * outbox_events is committed atomically with the subscription write.
 * No special transaction here — the caller controls the boundary.
 */

/**
 * Enqueue a Kafka publish into the outbox.
 *
 * @param {object} client      pg client inside the caller's transaction
 * @param {string} topic       kafka topic name
 * @param {string|null} key    kafka message key (sets partition stickiness)
 * @param {string} value       JSON-serialised message body
 * @returns {Promise<string>}  the new outbox row id
 */
async function enqueueOutbox(client, topic, key, value) {
  const r = await client.query(
    `INSERT INTO outbox_events (topic, message_key, message_value)
     VALUES ($1, $2, $3) RETURNING id`,
    [topic, key, value]
  );
  return r.rows[0].id;
}

module.exports = { enqueueOutbox };
