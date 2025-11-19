const express = require("express");
const Razorpay = require("razorpay");
const cors = require("cors");
const bodyParser = require("body-parser");
const crypto = require("crypto");

const app = express();
app.use(cors());
app.use(bodyParser.json());

// ENV VARIABLES (from Render)
const KEY_ID = process.env.RAZORPAY_KEY_ID;
const KEY_SECRET = process.env.RAZORPAY_KEY_SECRET;

if (!KEY_ID || !KEY_SECRET) {
  console.warn("⚠️ RAZORPAY_KEY_ID or RAZORPAY_KEY_SECRET is missing");
}

// Razorpay instance
const razorpay = new Razorpay({
  key_id: KEY_ID,
  key_secret: KEY_SECRET,
});

// Health check route
app.get("/", (req, res) => {
  res.send("Interprex backend is running");
});

// Create order
app.post("/create-order", async (req, res) => {
  try {
    const { amount, currency = "INR", receipt, notes } = req.body;

    if (!amount) {
      return res.status(400).json({ error: "Amount is required" });
    }

    const options = {
      amount, // in paise
      currency,
      receipt: receipt || "order_rcpt_" + Date.now(),
      notes: notes || {},
    };

    const order = await razorpay.orders.create(options);
    console.log("Order created:", order.id);
    res.json(order);
  } catch (err) {
    console.error("Create order error:", err);
    res.status(500).json({ error: "Unable to create order" });
  }
});

// Verify payment
app.post("/verify-payment", (req, res) => {
  try {
    const {
      razorpay_order_id,
      razorpay_payment_id,
      razorpay_signature,
    } = req.body;

    if (!razorpay_order_id || !razorpay_payment_id || !razorpay_signature) {
      return res
        .status(400)
        .json({ success: false, message: "Missing payment details" });
    }

    const body = razorpay_order_id + "|" + razorpay_payment_id;

    const expectedSignature = crypto
      .createHmac("sha256", KEY_SECRET)
      .update(body.toString())
      .digest("hex");

    const isAuthentic = expectedSignature === razorpay_signature;

    if (!isAuthentic) {
      console.log("Invalid signature", {
        expectedSignature,
        razorpay_signature,
      });
      return res
        .status(400)
        .json({ success: false, message: "Invalid signature" });
    }

    console.log("PAYMENT VERIFIED:", {
      razorpay_order_id,
      razorpay_payment_id,
    });

    // Later: save this in DB / Supabase
    res.json({ success: true });
  } catch (err) {
    console.error("Verify error:", err);
    res
      .status(500)
      .json({ success: false, message: "Server error verifying payment" });
  }
});

const PORT = process.env.PORT || 5000;
app.listen(PORT, () => {
  console.log("Server running on port", PORT);
});
