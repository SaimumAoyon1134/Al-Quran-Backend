const express = require("express");
const { MongoClient, ServerApiVersion } = require("mongodb");

const PORT = process.env.PORT || 4000;
require("dotenv").config();

const uri = process.env.MONGODB_URI;

// Create a MongoClient with a MongoClientOptions object to set the Stable API version
const client = new MongoClient(uri, {
  serverApi: {
    version: ServerApiVersion.v1,
    strict: true,
    deprecationErrors: true,
  },
});
const cors = require("cors");

const app = express();
app.use(cors());

async function start() {
  try {
    await client.connect();
    console.log("Connected to MongoDB");

    const db = client.db("quranDB");
    const searchCollection = db.collection("searchIndex");
    const surahsCollection = db.collection("surahs");
    const ayahsCollection = db.collection("ayahs");

    // Ensure text index exists for search
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

    app.use(express.json());

    app.get("/surahs", async (req, res) => {
      try {
        const cursor = surahsCollection.find({});
        const results = await cursor.toArray();
        res.json(results);
      } catch (err) {
        console.error("GET /surahs error", err);
        res.status(500).json({ error: String(err) });
      }
    });

    app.get("/surahs/:number", async (req, res) => {
      const num = Number(req.params.number);
      if (Number.isNaN(num))
        return res.status(400).json({ error: "Invalid surah number" });
      try {
        const surah = await surahsCollection.findOne({ number: num });
        if (!surah) return res.status(404).json({ error: "Surah not found" });
        res.json(surah);
      } catch (err) {
        console.error("GET /surahs/:number error", err);
        res.status(500).json({ error: String(err) });
      }
    });

    app.get("/ayahs", async (req, res) => {
      try {
        const surahQuery = req.query.surah;
        let filter = {};
        if (surahQuery !== undefined) {
          const sNum = Number(surahQuery);
          if (!Number.isNaN(sNum)) filter = { surahNumber: sNum };
        }

        // Use aggregation to group by `id` and return the first document per id.
        // This prevents duplicates from being returned if the collection has
        // accidental duplicate documents for the same ayah.
        const pipeline = [
          { $match: filter },
          // ensure a predictable order before grouping so $first is stable
          { $sort: { ayahNumber: 1, surahNumber: 1 } },
          { $group: { _id: "$id", doc: { $first: "$$ROOT" } } },
          { $replaceRoot: { newRoot: "$doc" } },
          { $sort: { ayahNumber: 1 } },
          { $limit: 5000 },
        ];

        const results = await ayahsCollection.aggregate(pipeline).toArray();
        res.json(results);
      } catch (err) {
        console.error("GET /ayahs error", err);
        res.status(500).json({ error: String(err) });
      }
    });

    app.get("/search", async (req, res) => {
      const q = String(req.query.q || "").trim();

      if (!q) {
        return res.status(400).json({ error: "Missing query parameter `q`" });
      }

      const escaped = q.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      const regex = new RegExp(escaped, "i");

      try {
        const indexes = await searchCollection.indexes();
        const hasTextIndex = indexes.some((index) =>
          Object.values(index.key || {}).includes("text")
        );

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

    // Expose the full search index for clients that need a local fallback
    // (e.g., offline/dev mode). This returns the documents from the
    // `searchIndex` collection. Be cautious with large payloads in prod.
    app.get("/search-index", async (req, res) => {
      try {
        const cursor = searchCollection.find({});
        const results = await cursor.limit(10000).toArray();
        res.json(results);
      } catch (err) {
        console.error("GET /search-index error", err);
        res.status(500).json({ error: String(err) });
      }
    });

    app.listen(PORT, () => {
      console.log(`Backend API listening on http://localhost:${PORT}`);
    });

    process.on("SIGINT", async () => {
      console.log("Shutting down...");
      await client.close();
      process.exit(0);
    });
  } catch (err) {
    console.error("Failed to start backend", err);
    process.exit(1);
  }
}

start();
