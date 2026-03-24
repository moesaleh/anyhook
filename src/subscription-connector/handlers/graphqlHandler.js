const { ApolloClient, InMemoryCache } = require('@apollo/client/core');
const { createClient } = require('graphql-ws'); // New WebSocket client
const { WebSocket } = require('ws'); // Use ws WebSocket implementation for Node.js
const gql = require('graphql-tag');
const BaseHandler = require('./baseHandler');

class GraphQLHandler extends BaseHandler {
    constructor(producer, redisClient) {
        super(producer, redisClient);
        this.activeSubscriptions = {}; // Track active subscriptions by ID
        this.wsClients = {}; // Store WebSocket client instances by subscription ID
    }

    async connect(subscription) {
        const { args, subscription_id } = subscription;
        const { query, endpoint_url, headers } = args;

        console.log(`[GraphQLHandler] - Connecting to WebSocket for subscription ID: ${subscription_id}`);
        console.log(`[GraphQLHandler] - Endpoint URL: ${endpoint_url}`);
        console.log(`[GraphQLHandler] - GraphQL Query: ${query}`);

        // Parse headers safely
        let parsedHeaders = {};
        if (headers) {
            try {
                parsedHeaders = typeof headers === 'object' ? headers : JSON.parse(headers);
            } catch (err) {
                console.error(`[GraphQLHandler] - Failed to parse headers for subscription ID: ${subscription_id}`, err);
            }
        }

        try {
            // Create a WebSocket client using graphql-ws
            const wsClient = createClient({
                url: endpoint_url,
                webSocketImpl: WebSocket,
                retryAttempts: 3, // Automatically retry failed connections
                connectionParams: {
                    headers: parsedHeaders
                }
            });

            wsClient.on('connecting', () => console.log('WebSocket connecting...'));
            wsClient.on('connected', () => console.log('WebSocket connected.'));
            wsClient.on('closed', () => console.log('WebSocket connection closed.'));
            wsClient.on('error', (error) => console.error('WebSocket error:', error));

            // Execute the subscription query
            const subscriptionQuery = gql`${query}`;
            const unsubscribe = wsClient.subscribe(
                {
                    query: subscriptionQuery.loc.source.body,
                },
                {
                    next: (data) => {
                        console.log(`[GraphQLHandler] - New data received for subscription ID: ${subscription_id}`, JSON.stringify(data));

                        // Raise event for processing
                        console.log(`Processing message for subscription ID: ${subscription_id}`);
                        this.raiseConnectionEvent(subscription_id, data);
                    },
                    error: (err) => {
                        console.error(`[GraphQLHandler] - Subscription error for subscription ID: ${subscription_id}`, err);
                    },
                    complete: () => {
                        console.log(`[GraphQLHandler] - Subscription completed for subscription ID: ${subscription_id}`);
                    },
                }
            );

            // Store the unsubscribe function for later cleanup
            this.activeSubscriptions[subscription_id] = unsubscribe;
            this.wsClients[subscription_id] = wsClient;

        } catch (err) {
            console.error(`[GraphQLHandler] - Error connecting WebSocket for subscription ID: ${subscription_id}`, err);
        }
    }

    disconnect(subscriptionId) {
        console.log(`[GraphQLHandler] - Disconnecting subscription for ID: ${subscriptionId}`);

        // Unsubscribe from active subscription
        if (this.activeSubscriptions[subscriptionId]) {
            this.activeSubscriptions[subscriptionId]();
            delete this.activeSubscriptions[subscriptionId];
            console.log(`[GraphQLHandler] - Unsubscribed from subscription ID: ${subscriptionId}`);
        }

        // Close WebSocket connection
        if (this.wsClients[subscriptionId]) {
            this.wsClients[subscriptionId].dispose();
            delete this.wsClients[subscriptionId];
            console.log(`[GraphQLHandler] - WebSocket connection closed for subscription ID: ${subscriptionId}`);
        }
    }
}

module.exports = GraphQLHandler;
