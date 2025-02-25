const { DynamoDBClient } = require("@aws-sdk/client-dynamodb");

const {
  DynamoDBDocumentClient,
  QueryCommand,
  PutCommand,
  UpdateCommand,
  DeleteCommand,
} = require("@aws-sdk/lib-dynamodb");

const express = require("express");
const multer  = require("multer");
const cors = require("cors");
const axios = require("axios");
const serverless = require("serverless-http");
const { recoverMessageAddress, isAddress, getAddress } = require("viem");
const { v4: uuidv4 } = require("uuid");

const app = express();

const storage = multer.memoryStorage();
const upload = multer({
  storage,
  limits: { fileSize: 5 * 1024 * 1024 },
  fileFilter: (req, file, cb)=> {
    cb(null, file.mimetype.split("/")[0] === "image");
  },
});

const TTL = 24 * 60 * 60; // 1 day
const MESSAGES_TABLE = process.env.MESSAGES_TABLE;
const LIKES_TABLE = process.env.LIKES_TABLE;
const TENDERLY_ADMIN_RPC = process.env.TENDERLY_ADMIN_RPC;
const PINATA_API_KEY = process.env.PINATA_API_KEY;
const client = new DynamoDBClient();
const docClient = DynamoDBDocumentClient.from(client);

app.use(express.json());

app.use(cors({
  credentials: true,
  origin: ['http://localhost:3000', 'https://memez.me', 'https://dev.memez-me.pages.dev', 'https://*.memez-me.pages.dev'], //TODO: remove localhost for production
}));

app.post("/pinata",  upload.single("file"), async (req, res) => {
  const formData = new FormData();

  console.log(req.file);

  const blob = new Blob([req.file.buffer], { type: req.file.mimetype });
  const file = new File([blob], req.file.originalname, { type: req.file.mimetype });
  formData.append('file', file);

  const pinataMetadata = JSON.stringify({
    name: req.body.name ?? req.file.originalname,
  });
  formData.append('pinataMetadata', pinataMetadata);

  const pinataOptions = JSON.stringify({
    cidVersion: 0,
  })
  formData.append('pinataOptions', pinataOptions);

  try {
    const response = await axios.post("https://api.pinata.cloud/pinning/pinFileToIPFS", formData, {
      maxBodyLength: "Infinity",
      headers: {
        'Content-Type': `multipart/form-data; boundary=${formData._boundary}`,
        'Authorization': `Bearer ${PINATA_API_KEY}`
      }
    });
    res.status(200).json({ url: `ipfs://${response.data.IpfsHash}` });
  } catch (error) {
    console.error(error);
    if (axios.isAxiosError(error) && error.response?.data?.error) {
      res.status(500).json({ error: error.response.data.error });
    } else {
      throw error;
    }
  }
});

app.post("/faucet", async (req, res) => {
  const { address, amount } = req.body;

  await axios.post(TENDERLY_ADMIN_RPC, {
    jsonrpc: '2.0',
    method: 'tenderly_addBalance',
    params: [address, `0x${BigInt(amount).toString(16)}`],
    id: '1',
  });

  res.status(200).json({ message: 'OK' });
});

app.get("/messages/:memecoin", async (req, res) => {
  const { memecoin } = req.params;
  let { from=0 } = req.query;

  from = Number(from);

  if (typeof memecoin !== "string" || !isAddress(memecoin)) {
    res.status(400).json({ error: '"memecoin" must be an address' });
    return;
  } else if (!(from >= 0)) {
    res.status(400).json({ error: '"from" must be a non-negative number' });
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

  if (message.length > 200) {
    res.status(400).json({ error: '"message" must be no more than 200 characters length' });
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

app.use((req, res) => {
  return res.status(404).json({
    error: "Not Found",
  });
});

exports.handler = serverless(app);
