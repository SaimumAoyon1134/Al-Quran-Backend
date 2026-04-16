const express = require("express");
const cors = require("cors");
const { MongoClient, ServerApiVersion } = require("mongodb");

const app = express();
app.use(cors());
app.use(express.json());

const uri = process.env.MONGODB_URI;

if (!uri) {
  throw new Error("MONGODB_URI is not set");
}

const client = new MongoClient(uri, {
  serverApi: {
    version: ServerApiVersion.v1,
    strict: true,
    deprecationErrors: true,
  },
});

let db;
let searchCollection;
let surahsCollection;
let ayahsCollection;
let initPromise;

async function initDb() {
  if (db) {
    return;
  }

  if (!initPromise) {
    initPromise = (async () => {
      await client.connect();

      db = client.db("quranDB");
      searchCollection = db.collection("searchIndex");
      surahsCollection = db.collection("surahs");
      ayahsCollection = db.collection("ayahs");

      try {
        await searchCollection.createIndex(
          {
            translation: "text",
            translationBn: "text",
            englishTranslation: "text",
            surahNameEnglish: "text",
          },
          {
            name: "search_text_index",
          }
        );
      } catch (indexErr) {
        console.error("Failed to create search text index", indexErr);
      }
    })();
  }

  await initPromise;
}

app.get("/", async (_req, res) => {
  res.json({
    message: "Al-Quran backend is running",
    endpoints: ["/surahs", "/surahs/:number", "/ayahs?surah=1", "/search?q=guidance", "/search-index"],
  });
});

app.get("/surahs", async (_req, res) => {
  try {
    await initDb();
    const results = await surahsCollection.find({}).toArray();
    res.json(results);
  } catch (err) {
    console.error("GET /surahs error", err);
    res.status(500).json({ error: String(err) });
  }
});

app.get("/surahs/:number", async (req, res) => {
  try {
    await initDb();

    const num = Number(req.params.number);
    if (Number.isNaN(num)) {
      return res.status(400).json({ error: "Invalid surah number" });
    }

    const surah = await surahsCollection.findOne({ number: num });
    if (!surah) {
      return res.status(404).json({ error: "Surah not found" });
    }

    return res.json(surah);
  } catch (err) {
    console.error("GET /surahs/:number error", err);
    return res.status(500).json({ error: String(err) });
  }
});

app.get("/ayahs", async (req, res) => {
  try {
    await initDb();

    const surahQuery = req.query.surah;
    let filter = {};

    if (surahQuery !== undefined) {
      const sNum = Number(surahQuery);
      if (!Number.isNaN(sNum)) {
        filter = { surahNumber: sNum };
      }
    }

    const pipeline = [
      { $match: filter },
      { $sort: { ayahNumber: 1, surahNumber: 1 } },
      { $group: { _id: "$id", doc: { $first: "$$ROOT" } } },
      { $replaceRoot: { newRoot: "$doc" } },
      { $sort: { ayahNumber: 1 } },
      { $limit: 5000 },
    ];

    const results = await ayahsCollection.aggregate(pipeline).toArray();
    return res.json(results);
  } catch (err) {
    console.error("GET /ayahs error", err);
    return res.status(500).json({ error: String(err) });
  }
});

app.get("/search", async (req, res) => {
  try {
    await initDb();

    const q = String(req.query.q || "").trim();
    if (!q) {
      return res.status(400).json({ error: "Missing query parameter `q`" });
    }

    const escaped = q.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const regex = new RegExp(escaped, "i");

    const indexes = await searchCollection.indexes();
    const hasTextIndex = indexes.some((index) => Object.values(index.key || {}).includes("text"));

    if (!hasTextIndex) {
      const regexResults = await searchCollection
        .find({
          $or: [
            { translation: regex },
            { translationBn: regex },
            { englishTranslation: regex },
            { surahNameEnglish: regex },
          ],
        })
        .limit(50)
        .toArray();

      return res.json(regexResults);
    }

    const results = await searchCollection
      .find(
        { $text: { $search: q } },
        {
          projection: {
            score: { $meta: "textScore" },
          },
        }
      )
      .sort({ score: { $meta: "textScore" } })
      .limit(50)
      .toArray();

    return res.json(results);
  } catch (err) {
    console.error("GET /search text search failed, using regex fallback", err);

    try {
      await initDb();
      const q = String(req.query.q || "").trim();
      const escaped = q.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      const regex = new RegExp(escaped, "i");

      const regexResults = await searchCollection
        .find({
          $or: [
            { translation: regex },
            { translationBn: regex },
            { englishTranslation: regex },
            { surahNameEnglish: regex },
          ],
        })
        .limit(50)
        .toArray();

      return res.json(regexResults);
    } catch (fallbackErr) {
      console.error("GET /search fallback error", fallbackErr);
      return res.status(500).json({ error: String(fallbackErr) });
    }
  }
});

app.get("/search-index", async (_req, res) => {
  try {
    await initDb();
    const results = await searchCollection.find({}).limit(10000).toArray();
    res.json(results);
  } catch (err) {
    console.error("GET /search-index error", err);
    res.status(500).json({ error: String(err) });
  }
});

module.exports = app;
