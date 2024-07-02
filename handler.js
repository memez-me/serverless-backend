const { DynamoDBClient } = require("@aws-sdk/client-dynamodb");

const {
  DynamoDBDocumentClient,
  QueryCommand,
  PutCommand,
  UpdateCommand,
  DeleteCommand,
} = require("@aws-sdk/lib-dynamodb");

const express = require("express");
const serverless = require("serverless-http");
const { recoverMessageAddress, isAddress, getAddress } = require("viem");
const { v4: uuidv4 } = require('uuid');

const app = express();

const TTL = 24 * 60 * 60; // 1 day
const MESSAGES_TABLE = process.env.MESSAGES_TABLE;
const LIKES_TABLE = process.env.LIKES_TABLE;
const client = new DynamoDBClient();
const docClient = DynamoDBDocumentClient.from(client);

app.use(express.json());

app.get("/messages/:memecoin", async (req, res) => {
  const { memecoin } = req.params;
  const { from=0 } = req.query;

  if (typeof memecoin !== "string" || !isAddress(memecoin)) {
    res.status(400).json({ error: '"memecoin" must be an address' });
    return;
  } else if (typeof from !== "number") {
    res.status(400).json({ error: '"from" must be a number' });
    return;
  }

  const params = {
    TableName: MESSAGES_TABLE,
    IndexName: "MemecoinIndex",
    KeyConditionExpression: "memecoin = :m AND #ts >= :t",
    ExpressionAttributeValues: {
      ":m": getAddress(memecoin),
      ":t": from
    },
    ExpressionAttributeNames: {
      "#ts": "timestamp"
    }
  };

  try {
    const command = new QueryCommand(params);
    const { Items } = await docClient.send(command);
    if (Items) {
      res.json(Items);
    } else {
      res
        .status(404)
        .json({ error: 'Could not find messages by "memecoin" and "from"' });
    }
  } catch (error) {
    console.log(error);
    res.status(500).json({ error: "Could not retrieve messages" });
  }
});

app.post("/messages/:memecoin", async (req, res) => {
  const { memecoin } = req.params;
  const { auth: { timestamp, signature } = {}, message } = req.body;

  if (typeof memecoin !== "string" || !isAddress(memecoin)) {
    res.status(400).json({ error: '"memecoin" must be an address' });
    return;
  } else if (typeof timestamp !== "number") {
    res.status(400).json({ error: '"timestamp" must be a number' });
    return;
  } else if (typeof signature !== "string") {
    res.status(400).json({ error: '"signature" must be a string' });
    return;
  } else if (typeof message !== "string") {
    res.status(400).json({ error: '"message" must be a string' });
    return;
  }

  const unixTimestampNow = Math.floor(Date.now() / 1000);
  if (timestamp > unixTimestampNow) {
    res.status(400).json({ error: '"timestamp" must not be in the future' });
    return;
  } else if (timestamp + TTL < unixTimestampNow) {
    res.status(401).json({ error: 'signature expired' });
    return;
  }

  const author = await recoverMessageAddress({
    message: `Signing in on memez.me at ${timestamp}`,
    signature,
  });

  const item = {
    id: uuidv4(),
    author,
    memecoin: getAddress(memecoin),
    timestamp: unixTimestampNow,
    message,
    likes: 0,
  };

  const params = {
    TableName: MESSAGES_TABLE,
    Item: item,
  };

  try {
    const command = new PutCommand(params);
    await docClient.send(command);
    res.status(201).json(item);
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "Could not add message" });
  }
});

app.get("/likes/:user", async (req, res) => {
  const { user } = req.params;

  if (typeof user !== "string" || !isAddress(user)) {
    res.status(400).json({ error: '"user" must be an address' });
    return;
  }

  const params = {
    TableName: LIKES_TABLE,
    IndexName: "UserIndex",
    KeyConditionExpression: "#u = :u",
    ExpressionAttributeValues: {
      ":u": getAddress(user)
    },
    ExpressionAttributeNames: {
      "#u": "user"
    }
  };

  try {
    const command = new QueryCommand(params);
    const { Items } = await docClient.send(command);
    if (Items) {
      res.json(Items);
    } else {
      res
          .status(404)
          .json({ error: 'Could not find likes of "user"' });
    }
  } catch (error) {
    console.log(error);
    res.status(500).json({ error: "Could not retrieve likes" });
  }
});

app.post("/message/:messageId/like", async (req, res) => {
  const { messageId } = req.params;
  const { auth: { timestamp, signature } = {} } = req.body;

  if (typeof messageId !== "string") {
    res.status(400).json({ error: '"messageId" must be a string' });
    return;
  } else if (typeof timestamp !== "number") {
    res.status(400).json({ error: '"timestamp" must be a number' });
    return;
  } else if (typeof signature !== "string") {
    res.status(400).json({ error: '"signature" must be a string' });
    return;
  }

  const unixTimestampNow = Math.floor(Date.now() / 1000);
  if (timestamp > unixTimestampNow) {
    res.status(400).json({ error: '"timestamp" must not be in the future' });
    return;
  } else if (timestamp + TTL < unixTimestampNow) {
    res.status(401).json({ error: 'signature expired' });
    return;
  }

  const user = await recoverMessageAddress({
    message: `Signing in on memez.me at ${timestamp}`,
    signature,
  });

  const id = `${messageId}-${user}`;

  const item = {
    id,
    user,
    messageId,
  };

  const params = {
    TableName: LIKES_TABLE,
    Item: item,
    ConditionExpression: "id <> :id",
    ExpressionAttributeValues: {
      ":id" : id
    },
  };

  try {
    const command = new PutCommand(params);
    await docClient.send(command);
    try {
      const incrementParams = {
        TableName: MESSAGES_TABLE,
        Key: {
          "id": messageId,
        },
        ExpressionAttributeValues: {
          ":inc": 1
        },
        UpdateExpression: "ADD likes :inc",
        ReturnValues: 'UPDATED_NEW'
      };
      const incrementCommand = new UpdateCommand(incrementParams);
      const result = await docClient.send(incrementCommand);
      res.status(200).json(result.Attributes);
    }  catch (error) {
      console.error(error);
      res.status(500).json({ error: "Could not update likes count of message" });
    }
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "Could not like message" });
  }
});

app.post("/message/:messageId/unlike", async (req, res) => {
  const { messageId } = req.params;
  const { auth: { timestamp, signature } = {} } = req.body;

  if (typeof messageId !== "string") {
    res.status(400).json({ error: '"messageId" must be a string' });
    return;
  } else if (typeof timestamp !== "number") {
    res.status(400).json({ error: '"timestamp" must be a number' });
    return;
  } else if (typeof signature !== "string") {
    res.status(400).json({ error: '"signature" must be a string' });
    return;
  }

  const unixTimestampNow = Math.floor(Date.now() / 1000);
  if (timestamp > unixTimestampNow) {
    res.status(400).json({ error: '"timestamp" must not be in the future' });
    return;
  } else if (timestamp + TTL < unixTimestampNow) {
    res.status(401).json({ error: 'signature expired' });
    return;
  }

  const user = await recoverMessageAddress({
    message: `Signing in on memez.me at ${timestamp}`,
    signature,
  });

  const id = `${messageId}-${user}`;

  const item = {
    id,
    user,
  };

  const params = {
    TableName: LIKES_TABLE,
    Key: {
      "id": id,
    },
    ConditionExpression: "attribute_exists(#u)",
    ExpressionAttributeNames: {
      "#u": "user"
    }
  };

  try {
    const command = new DeleteCommand(params);
    await docClient.send(command);
    try {
      const decrementParams = {
        TableName: MESSAGES_TABLE,
        Key: {
          "id": messageId,
        },
        ExpressionAttributeValues: {
          ":dec": -1
        },
        UpdateExpression: "ADD likes :dec",
        ReturnValues: 'UPDATED_NEW'
      };
      const decrementCommand = new UpdateCommand(decrementParams);
      const result = await docClient.send(decrementCommand);
      res.status(200).json(result.Attributes);
    }  catch (error) {
      console.error(error);
      res.status(500).json({ error: "Could not update likes count of message" });
    }
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "Could not unlike message" });
  }
});

app.use((req, res, next) => {
  return res.status(404).json({
    error: "Not Found",
  });
});

exports.handler = serverless(app);
