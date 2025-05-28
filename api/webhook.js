// api/webhook.js
const { createClient } = require("@supabase/supabase-js");
const twilio = require("twilio");

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_ANON_KEY
);
const twilioClient = twilio(
  process.env.TWILIO_ACCOUNT_SID,
  process.env.TWILIO_AUTH_TOKEN
);

const WHATSAPP_NUMBER = process.env.TWILIO_WHATSAPP_NUMBER;

unction parseFlightMessage(message) {
  // Normalize whitespace, remove CORR or any leading labels
  message = message
    .replace(/^CORR\s*/i, "")
    .replace(/^\s*MVT\s*/i, "")
    .replace(/\r/g, "")
    .replace(/\n{2,}/g, "\n")
    .trim();

  // Split into lines, trim, remove empties
  const lines = message.split("\n").map(l => l.trim()).filter(Boolean);

  // Defaults
  let flight_no = "", flight_date = null, aircraft = "", departure = "", arrival = "";
  let std = "", atd = "", remark = "", delay_reason = "", schedule_status = "";
  let premium = null, economy = null, infant = null, total_pax = null, capacity = null;
  let route = "";

  // Info line: e.g., "IAN521 250527 5N-CEE"
  let infoLine = lines.find(l => /^[A-Z]{3}\d{3}\s+\d{6}/.test(l));
  if (!infoLine) {
    console.log("❌ Could not find infoLine in message:", message);
    return null;
  }
  let [flightNo, dateStr, aircraftCode] = infoLine.split(/\s+/);
  flight_no = flightNo || "";
  aircraft = aircraftCode || "";

  // dateStr: 250527 → 2025-05-27
  if (/^\d{6}$/.test(dateStr)) {
    let yy = dateStr.slice(0, 2), mm = dateStr.slice(2, 4), dd = dateStr.slice(4, 6);
    flight_date = `20${yy}-${mm}-${dd}`;
  }

  // Route line, e.g. "ABV-LOS"
  let routeLine = lines.find(l => /^[A-Z]{3,4}-[A-Z]{3,4}/.test(l));
  if (routeLine) {
    [departure, arrival] = routeLine.split("-");
    route = routeLine;
  }

  // Parse STD/ATD, allow for C/O, STD, ATD, A/B, and other possible labels
  for (let l of lines) {
    // STD (C/O, STD)
    let stdMatch = l.match(/(?:C\/O|STD)[:\s]*([0-2][0-9])[:]?([0-5][0-9])?/i);
    if (stdMatch) std = stdMatch[2] ? `${stdMatch[1]}:${stdMatch[2]}` : stdMatch[1];

    // ATD (A/B, ATD)
    let atdMatch = l.match(/(?:A\/B|ATD)[:\s]*([0-2][0-9])[:]?([0-5][0-9])?/i);
    if (atdMatch) atd = atdMatch[2] ? `${atdMatch[1]}:${atdMatch[2]}` : atdMatch[1];
  }

  // Parse PAX lines, e.g.:
  // - PAX: (130)09/120+01inf
  // - PAX: (77)07/70
  // - PAX: 09/120+01inf
  // - PAX: 09/120
  let paxLine = lines.find(l => /PAX[:\.]/i.test(l));
  if (paxLine) {
    // PAX: (130)09/120+01inf
    let match = paxLine.match(/\(?(\d+)\)?\s*(\d{1,2})\/(\d{2,3})(\+(\d{1,2})(inf|INF))?/);
    if (match) {
      total_pax = parseInt(match[1], 10);
      premium = parseInt(match[2], 10);
      economy = parseInt(match[3], 10);
      // Infant can be after a "+", e.g., "+01inf"
      if (match[5]) infant = parseInt(match[5], 10);
      capacity = economy;
    } else {
      // fallback for PAX: 08/70 (Premium/Economy style)
      let fallback = paxLine.match(/PAX[:\.]?\s*(\d{1,2})\/(\d{2,3})/i);
      if (fallback) {
        premium = parseInt(fallback[1], 10);
        economy = parseInt(fallback[2], 10);
        capacity = economy;
      }
      // Find infant as "+01inf" anywhere
      let infFallback = paxLine.match(/\+(\d{1,2})(inf|INF)/);
      if (infFallback) infant = parseInt(infFallback[1], 10);
    }
  }

  // "DLY:" or "DLY: REACTIONARY" for delay reason
  let dlyLine = lines.find(l => /^DLY[:\.]/i.test(l));
  if (dlyLine) {
    delay_reason = dlyLine.replace(/^DLY[:\.]\s*/i, "");
  }

  // Remarks/other fields
  for (let l of lines) {
    if (/^SI:/i.test(l)) remark = l.replace(/^SI:\s*/i, "");
    if (/^Remark[:\.]/i.test(l)) remark = l.replace(/^Remark[:\.]\s*/i, "");
    if (/^Delay Reason[:\.]/i.test(l)) delay_reason = l.replace(/^Delay Reason[:\.]\s*/i, "");
    if (/^Schedule Status[:\.]/i.test(l)) schedule_status = l.replace(/^Schedule Status[:\.]\s*/i, "");
  }

  // Compose and log result
  const rowObj = {
    flight_date,
    flight_no,
    aircraft,
    capacity,
    departure,
    arrival,
    route,
    std,
    atd,
    remark,
    delay_reason,
    schedule_status,
    premium,
    economy,
    infant,
    total_pax
  };
  console.log("Parsed row object:", rowObj);
  return rowObj;
}

// -------- Main Handler --------
module.exports = async (req, res) => {
  console.log("Incoming Twilio webhook:", req.body);

  // Twilio webhook sends as x-www-form-urlencoded!
  let body = req.body;
  if (typeof body === "string") {
    body = Object.fromEntries(new URLSearchParams(body));
  }

  let msg = body.Body?.trim() || "";
  let from = body.From;

  // Only handle WhatsApp
  if (!msg || !from || !from.startsWith("whatsapp:")) {
    console.log("❌ Not a WhatsApp message or missing fields:", { msg, from });
    res.status(400).send("Bad request");
    return;
  }

  // Parse message
  let parsed = parseFlightMessage(msg);
  let reply = "";
  if (!parsed || !parsed.flight_no || !parsed.flight_date) {
    console.log("❌ Parse failed. Parsed object:", parsed);
    reply = "❌ Error: Could not parse flight message. Check your format.";
  } else {
    // Upsert into Supabase
    console.log("Upserting into Supabase:", parsed);
    const { error } = await supabase
      .from("flights")
      .upsert([parsed], { onConflict: ["flight_no", "flight_date"] });
    reply = error
      ? "❌ Error: Could not save flight record."
      : "✅ MVT message received and stored!";
    if (error) console.log("❌ Supabase error:", error);
    else console.log("✅ Supabase upsert successful");
  }

  // Respond via Twilio WhatsApp
  try {
    console.log("Sending reply to WhatsApp:", reply);
    await twilioClient.messages.create({
      from: WHATSAPP_NUMBER,
      to: from,
      body: reply
    });
    console.log("✅ Reply sent to WhatsApp user:", from);
  } catch (err) {
    console.log("❌ Twilio reply failed:", err);
    // Twilio reply failed, but always 200 to webhook (Twilio best practice)
  }

  res.status(200).send("OK");
};
