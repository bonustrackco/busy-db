const Promise = require("bluebird");
const fs = require("fs-extra");
const path = require("path");
const os = require("os");
const chalk = require("chalk");
const api = require("./api");
const getBatches = require("./getBatches");
const {
  addUser,
  addPost,
  addComment,
  deletePost,
  addVote,
  addFollow,
  removeFollow,
  addProducerReward,
  addAuthorReward,
  addCurationReward
} = require("./db");

const BASE_DIR = path.resolve(os.homedir(), "busydb");
const CACHE_DIR = path.resolve(BASE_DIR, "cache");
const MAX_BATCH = process.env.MAX_BATCH || 50;

async function getBatch(batch) {
  const requests = batch.map(block => ({
    method: "get_ops_in_block",
    params: [block]
  }));

  return await api
    .sendBatchAsync(requests, null)
    .reduce((a, b) => [...a, ...b], []);
}

async function processBatch(txs) {
  for (let tx of txs) {
    const [type, payload] = tx.op;
    const { timestamp } = tx;

    switch (type) {
      case "pow": {
        const auth = {
          weight_threshold: 1,
          account_auths: [],
          key_auths: [[payload.work.worker, 1]]
        };
        await addUser(
          timestamp,
          payload.worker_account,
          {},
          auth,
          auth,
          auth,
          payload.work.worker
        );
        break;
      }
      case "pow2": {
        let auth;
        let memoKey;
        if (payload.new_owner_key) {
          auth = {
            weight_threshold: 1,
            account_auths: [],
            key_auths: [[payload.new_owner_key, 1]]
          };
          memoKey = payload.new_owner_key;
        }
        await addUser(
          timestamp,
          payload.work[1].input.worker_account,
          {},
          auth,
          auth,
          auth,
          memoKey
        );
        break;
      }
      case "account_create":
      case "account_create_with_delegation": {
        let metadata = {};
        try {
          metadata = JSON.parse(payload.json_metadata);
        } catch (e) {} // eslint-disable-line no-empty
        await addUser(
          timestamp,
          payload.new_account_name,
          metadata,
          payload.owner,
          payload.active,
          payload.posting,
          payload.memo_key
        );
        break;
      }
      case "comment":
        if (!payload.parent_author) {
          await addPost(
            timestamp,
            payload.parent_permlink,
            payload.author,
            payload.permlink,
            payload.title,
            payload.body
          );
        } else {
          await addComment(
            timestamp,
            payload.parent_author,
            payload.parent_permlink,
            payload.author,
            payload.permlink,
            payload.body
          );
        }
        break;
      case "vote":
        await addVote(
          timestamp,
          payload.voter,
          payload.author,
          payload.permlink,
          payload.weight
        );
        break;
      case "delete_comment":
        await deletePost(timestamp, payload.author, payload.permlink);
        break;
      case "custom_json":
        if (payload.id === "follow") {
          const { follower, following, what } = JSON.parse(payload.json);
          if (what.includes("blog")) {
            await addFollow(timestamp, follower, following);
          } else if (what.includes("ignore") || what.length === 0) {
            await removeFollow(timestamp, follower, following);
          }
        }
        break;
      case "producer_reward":
        await addProducerReward(
          timestamp,
          payload.producer,
          payload.vesting_shares
        );
        break;
      case "author_reward":
        await addAuthorReward(
          timestamp,
          payload.author,
          payload.permlink,
          payload.sbd_payout,
          payload.steem_payout,
          payload.vesting_payout
        );
        break;
      case "curation_reward":
        await addCurationReward(
          timestamp,
          payload.curator,
          payload.reward,
          payload.comment_author,
          payload.comment_permlink
        );
        break;
    }
  }
}

async function syncOffline(head) {
  for (let i = 0; i <= head; i++) {
    if (i % 10 === 0) {
      console.log(chalk.blue(`Processing batch: ${i}`));
    }

    const resp = await fs.readFile(
      path.resolve(CACHE_DIR, `${i}.batch`),
      "utf8"
    );
    await processBatch(JSON.parse(resp));
  }

  console.log(chalk.green("Offline sync completed"));
}

async function syncOnline(head) {
  const batches = getBatches(1, 22910707, MAX_BATCH);

  const startBatch = head ? head + 1 : 0;

  for (let i = startBatch; i < batches.length; i++) {
    try {
      if (i % 10 === 0) {
        console.log(chalk.blue(`Processing batch: ${i}`));
      }
      const resp = await getBatch(batches[i]);
      await processBatch(resp);

      await fs.writeFile(
        path.resolve(CACHE_DIR, `${i}.batch`),
        JSON.stringify(resp)
      );
      await fs.writeFile(path.resolve(BASE_DIR, "head"), i);
    } catch (err) {
      console.log(err);
      await Promise.delay(2000);
      i--;
    }
  }
}

module.exports = async function sync(offline) {
  await fs.ensureDir(CACHE_DIR);
  await fs.ensureFile(path.resolve(BASE_DIR, "head"));
  const head = parseInt(
    await fs.readFile(path.resolve(BASE_DIR, "head"), "utf8")
  );

  console.log(chalk.yellow(`Current head is: ${chalk.bold(head)}`));

  if (offline) {
    syncOffline(head);
  } else {
    syncOnline(head);
  }
};
