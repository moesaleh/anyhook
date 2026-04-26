const { ApolloServer, gql } = require('apollo-server');
const { PubSub } = require('graphql-subscriptions');

// Initialize PubSub for triggering subscriptions
const pubsub = new PubSub();
const MESSAGE_ADDED = 'MESSAGE_ADDED';

// Define GraphQL schema
const typeDefs = gql`
  type Message {
    id: ID!
    content: String!
  }

  type Query {
    messages: [Message!]
  }

  type Mutation {
    addMessage(content: String!): Message
  }

  type Subscription {
    messageAdded: Message
  }
`;

// Sample data
let messages = [
  { id: '1', content: 'Hello World' },
  { id: '2', content: 'GraphQL is awesome' },
];

// Define resolvers
const resolvers = {
  Query: {
    messages: () => {
      console.log('[Query] - Fetching all messages');
      return messages;
    },
  },
  Mutation: {
    addMessage: (parent, { content }) => {
      const newMessage = { id: String(messages.length + 1), content };
      messages.push(newMessage);

      // Log the message addition
      console.log(
        `[Mutation] - New message added: ${newMessage.content} with ID: ${newMessage.id}`
      );

      // Publish the messageAdded event for subscriptions
      pubsub.publish(MESSAGE_ADDED, { messageAdded: newMessage });
      console.log('[Subscription] - Triggering messageAdded event for subscribers');

      return newMessage;
    },
  },
  Subscription: {
    messageAdded: {
      subscribe: () => {
        console.log('[Subscription] - New subscription for messageAdded');
        return pubsub.asyncIterator([MESSAGE_ADDED]);
      },
    },
  },
};

// Create Apollo Server
const server = new ApolloServer({
  typeDefs,
  resolvers,
  subscriptions: {
    onConnect: () => {
      console.log('[Subscriptions] - Client connected for subscriptions');
    },
    onDisconnect: () => {
      console.log('[Subscriptions] - Client disconnected from subscriptions');
    },
  },
});

// Start the server
server.listen().then(({ url }) => {
  console.log(`🚀 Server ready at ${url}`);
});
