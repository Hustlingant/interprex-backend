const express = require("express");
const Razorpay = require("razorpay");
const cors = require("cors");
const bodyParser = require("body-parser");
const crypto = require("crypto");
const { createClient } = require("@supabase/supabase-js");

const app = express();
app.use(cors());
app.use(bodyParser.json());

// ENV VARIABLES (from Render)
const KEY_ID = process.env.RAZORPAY_KEY_ID;
const KEY_SECRET = process.env.RAZORPAY_KEY_SECRET;

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!KEY_ID || !KEY_SECRET) {
  console.warn("⚠️ RAZORPAY_KEY_ID or RAZORPAY_KEY_SECRET is missing");
}
if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
  console.warn("⚠️ SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY is missing");
}

// Razorpay instance
const razorpay = new Razorpay({
  key_id: KEY_ID,
  key_secret: KEY_SECRET,
});

// Supabase service client (backend only)
const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

// Health check route
app.get("/", (req, res) => {
  res.send("Interprex backend is running");
});

/**
 * POST /create-order
 * Body: { amount, currency?, receipt?, course_slug, user_id }
 * - Creates a Razorpay order
 * - Stores course_slug + user_id in order.notes
 */
app.post("/create-order", async (req, res) => {
  try {
    const {
      amount,
      currency = "INR",
      receipt,
      notes,
      course_slug,
      user_id,
    } = req.body;

    // 🔍 Log what we received from frontend
    console.log("CREATE ORDER BODY:", {
      amount,
      course_slug,
      user_id,
    });

    if (!amount || !course_slug || !user_id) {
      return res
        .status(400)
        .json({ error: "Amount, course_slug and user_id are required" });
    }

    const options = {
      amount, // in paise
      currency,
      receipt: receipt || "order_rcpt_" + Date.now(),
      notes: {
        ...notes,
        course_slug,
        user_id,
      },
    };

    const order = await razorpay.orders.create(options);
    console.log(
      "Order created:",
      order.id,
      "user:",
      user_id,
      "course:",
      course_slug
    );
    res.json(order);
  } catch (err) {
    console.error("Create order error:", err);
    res.status(500).json({ error: "Unable to create order" });
  }
});

/**
 * POST /verify-payment
 * Body: { razorpay_order_id, razorpay_payment_id, razorpay_signature }
 * - Verifies Razorpay signature
 * - Fetches order to get notes (course_slug, user_id)
 * - Inserts into user_courses in Supabase
 */
app.post("/verify-payment", async (req, res) => {
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

    // 1) Verify signature
    const body = razorpay_order_id + "|" + razorpay_payment_id;

    const expectedSignature = crypto
      .createHmac("sha256", KEY_SECRET)
      .update(body.toString())
      .digest("hex");

    if (expectedSignature !== razorpay_signature) {
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

    // 2) Fetch order from Razorpay to get notes
    const order = await razorpay.orders.fetch(razorpay_order_id);
    const course_slug = order.notes?.course_slug;
    const user_id = order.notes?.user_id;

    // 🔍 Log exactly what we got from Razorpay
    console.log("ORDER NOTES:", {
      notes: order.notes,
      course_slug,
      user_id,
    });

    if (!course_slug || !user_id) {
      console.error("Missing course_slug or user_id in order notes");
      return res
        .status(500)
        .json({ success: false, message: "Missing metadata" });
    }

    // 3) Get course_id from slug
    const { data: course, error: courseError } = await supabase
      .from("courses")
      .select("id, slug")
      .eq("slug", course_slug)
      .single();

    console.log("COURSE LOOKUP RESULT:", {
      course_slug,
      course,
      courseError,
    });

    if (courseError || !course) {
      console.error("Course not found:", courseError);
      return res.status(500).json({
        success: false,
        message: "Course not found",
        slug_received: course_slug,
      });
    }

    // 4) Insert into user_courses (grant access)
    const { error: ucError } = await supabase.from("user_courses").insert({
      user_id,
      course_id: course.id,
    });

    // 23505 = unique violation (user already has course)
    if (ucError && ucError.code !== "23505") {
      console.error("Error inserting user_courses:", ucError);
      return res
        .status(500)
        .json({ success: false, message: "Could not grant access" });
    }

    console.log("Course access granted:", { user_id, course_id: course.id });

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
