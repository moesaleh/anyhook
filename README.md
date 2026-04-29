# AnyHook

<div align="center">

[![GitHub license](https://img.shields.io/github/license/SwanBlocks-inc/anyhook)](https://github.com/SwanBlocks-inc/anyhook/blob/main/LICENSE)
[![GitHub stars](https://img.shields.io/github/stars/SwanBlocks-inc/anyhook)](https://github.com/SwanBlocks-inc/anyhook/stargazers)
[![GitHub issues](https://img.shields.io/github/issues/SwanBlocks-inc/anyhook)](https://github.com/SwanBlocks-inc/anyhook/issues)
[![GitHub pull requests](https://img.shields.io/github/issues-pr/SwanBlocks-inc/anyhook)](https://github.com/SwanBlocks-inc/anyhook/pulls)
[![Build Status](https://github.com/SwanBlocks-inc/anyhook/workflows/CI/CD%20Pipeline/badge.svg)](https://github.com/SwanBlocks-inc/anyhook/actions)

</div>

AnyHook is a powerful and flexible subscription proxy server that connects various data sources (GraphQL, WebSocket) to webhook endpoints in real-time. It provides a robust, scalable, and fault-tolerant solution for managing subscriptions and delivering real-time data to your applications.

## 🚀 Features

- **Multiple Data Source Support**
  - GraphQL Subscriptions
  - WebSocket Connections
  - Easy to extend for other protocols

- **Robust Architecture**
  - Microservices-based design
  - Event-driven architecture using Kafka
  - High availability and fault tolerance

- **Advanced Capabilities**
  - Automatic reconnection handling
  - Configurable retry mechanisms
  - Dead Letter Queue (DLQ) for failed deliveries
  - Rate limiting and throttling
  - Monitoring and metrics

- **Developer-Friendly**
  - Clear documentation
  - Easy to set up and configure
  - Extensible architecture
  - Docker support

## 🛠️ Quick Start

### Using Docker Compose

```bash
# Clone the repository
git clone https://github.com/SwanBlocks-inc/anyhook.git
cd anyhook

# Copy and configure environment variables
cp .env.example .env

# Start the services
docker-compose up -d
```

### Manual Installation

```bash
# Install dependencies
npm install

# Start the server
npm start
```

## 🔧 Configuration

AnyHook can be configured using environment variables. See [.env.example](.env.example).


## 🏗️ Architecture

AnyHook consists of three main components:

1. **Subscription Management**
   - Handles subscription creation and deletion
   - Manages subscription metadata
   - Provides REST API endpoints

2. **Subscription Connector**
   - Manages connections to data sources
   - Handles protocol-specific logic
   - Ensures reliable data streaming

3. **Webhook Dispatcher**
   - Delivers data to webhook endpoints
   - Implements retry logic
   - Manages failed delivery handling

## 🤝 Contributing

We welcome contributions! Please see our [Contributing Guidelines](CONTRIBUTING.md) for details.

## 📜 License

This project is licensed under the MIT License - see the [LICENSE](LICENSE) file for details.

## 🔒 Security

For security issues, please see our [Security Policy](SECURITY.md).

## 🌟 Support

- 🐛 Report bugs by opening [GitHub issues](https://github.com/SwanBlocks-inc/anyhook/issues)
- 💡 Request features in our [GitHub discussions](https://github.com/SwanBlocks-inc/anyhook/discussions)

## 🙏 Acknowledgments

Special thanks to all our contributors and the open source community!

---

## Overview

The Subscription Proxy Server acts as an intermediary between external data sources (such as GraphQL and WebSocket connections) and webhook endpoints, dynamically managing subscriptions and forwarding data to webhooks in real-time. It is highly scalable, fault-tolerant, and capable of handling various connection types. The system is designed with three major components: Subscription Management, Subscription Connector, and Webhook Dispatcher, all integrated with Kafka, Redis, and PostgreSQL for event-driven messaging, caching, and persistence.

## Architecture

The system is divided into the following components:

### 1. **Subscription Management Component**
- **Role**: Handles the creation and deletion of subscriptions.
- **Endpoints**:
  - `/subscribe`: Creates a new subscription, stores it in PostgreSQL and Redis, and sends an event to Kafka.
  - `/unsubscribe`: Deletes an existing subscription, removes it from PostgreSQL and Redis, and sends an event to Kafka.
- **Persistence**: Subscriptions are stored in a PostgreSQL database and cached in Redis for fast access.
- **Event-Driven Messaging**: Events are published to Kafka topics for further processing by the Subscription Connector.

### 2. **Subscription Connector Component**
- **Role**: Manages connections based on subscription data, opening connections to GraphQL or WebSocket servers as required.
- **Capabilities**:
  - Dynamically selects the correct handler (GraphQL or WebSocket) based on the subscription type.
  - Re-establishes connections when restarted by loading subscriptions from Redis.
  - Listens for `subscription_events` and `unsubscribe_events` from Kafka to create or close connections.
- **Handlers**:
  - **GraphQLHandler**: Connects to GraphQL subscriptions and listens for incoming events.
  - **WebSocketHandler**: Connects to WebSocket endpoints and listens for messages.
- **Fault Recovery**: On restart, it reloads all active subscriptions from Redis to ensure no subscriptions are lost.

### 3. **Webhook Dispatcher Component**
- **Role**: Forwards data received from subscriptions to the appropriate webhook URL.
- **Capabilities**:
  - Consumes events from Kafka topics and sends the corresponding data to the registered webhook.
  - Handles retry logic for failed webhook deliveries using exponential backoff, with intervals of 15 minutes, 1 hour, 2 hours, 6 hours, 12 hours, and 24 hours.
  - Moves failed messages to a Dead Letter Queue (DLQ) after maximum retry attempts and notifies the system admin.

### 4. **Kafka**
- **Role**: Acts as the event bus for communication between components.
- **Kafka Topics**:
  - `subscription_events`: Published by the Subscription Management component when a new subscription is created.
  - `unsubscribe_events`: Published when a subscription is deleted.
  - `connection_events`: Consumed by the Webhook Dispatcher to forward data to webhooks.
  - `dlq_events`: Used for messages that failed all retry attempts.

### 5. **Redis**
- **Role**: Caching layer to store subscription details for fast access by the Subscription Connector. Redis stores active subscriptions, and the connector reloads connections from Redis upon restarting.
- **Fault Tolerance**: Redis ensures that active subscriptions are maintained in memory, and the connector can reload subscriptions after failure or restart.

### 6. **PostgreSQL**
- **Role**: Persistent storage for subscription data. This ensures that subscriptions can be permanently stored and recovered after system failures.

---

## System Flow

1. **Subscription Creation**: When a client subscribes through the `/subscribe` API, the subscription is saved in PostgreSQL, cached in Redis, and a `subscription_events` message is published to Kafka.
2. **Connection Handling**: The Subscription Connector component listens to Kafka events and establishes a connection (either GraphQL or WebSocket) based on the subscription type.
3. **Data Handling**: When data is received through the connection, it is published to the `connection_events` topic in Kafka.
4. **Webhook Dispatching**: The Webhook Dispatcher listens to `connection_events` and forwards the received data to the specified webhook. It retries delivery on failure and eventually sends failed messages to the DLQ if all retries fail.

---

## Technologies Used

- **Node.js**: Primary language for the Subscription Proxy Server.
- **Redis**: Used for caching subscription data.
- **PostgreSQL**: Persistent storage for subscriptions.
- **Kafka**: Event-driven messaging between components.
- **GraphQL & WebSocket**: Supported connection types.
- **Axios**: Used in the Webhook Dispatcher to send data to webhooks.

---

## Fault Tolerance and Recovery

- **Redis Caching**: Ensures active subscriptions are quickly accessible and can be reloaded after service restarts.
- **Automatic Reconnection**: On restart, the Subscription Connector reloads active subscriptions from Redis and re-establishes the connections.
- **Retry Logic**: For failed webhook deliveries, the system retries with exponential backoff. After reaching the retry limit, messages are moved to the Dead Letter Queue (DLQ).

---
