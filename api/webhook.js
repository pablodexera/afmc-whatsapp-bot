// api/webhook.js
const { createClient } = require("@supabase/supabase-js");
const twilio = require("twilio");

// Supabase and Twilio config from environment variables
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_ANON_KEY
);
const twilioClient = twilio(
  process.env.TWILIO_ACCOUNT_SID,
  process.env.TWILIO_AUTH_TOKEN
);

const WHATSAPP_NUMBER = process.env.TWILIO_WHATSAPP_NUMBER;

/**
 * Fuzzy parse a WhatsApp MVT flight message into a row object for Supabase.
 * Supports real-world imperfect formatting and both message sample styles.
 */
function parseFlightMessage(message) {
  // Normalize whitespace, remove CORR or any leading labels
  message = message
    .replace(/^CORR\s*/i, "")
    .replace(/^\s*MVT\s*/i, "")
    .replace(/\r/g, "")
    .replace(/\n{2,}/g, "\n")
    .trim();

  // Grab lines for processing
  const lines = message.split("\n").map(l => l.trim()).filter(Boolean);

  // Defaults
  let flight_no = "", flight_date = null, aircraft = "", departure = "", arrival = "";
  let std = "", atd = "", remark = "", delay_reason = "", schedule_status = "";
  let premium = null, economy = null, infant = null, total_pax = null, capacity = null;
  let route = "";

  // Parse lines: Example "IAN521 250527 5N-CEE"
  let infoLine = lines.find(l => /^[A-Z]{3}\d{3}\s+\d{6}/.test(l));
  if (!infoLine) return null;
  let [flightNo, dateStr, aircraftCode] = infoLine.split(/\s+/);
  flight_no = flightNo || "";
  aircraft = aircraftCode || "";

  // dateStr: 250527 → 2025-05-27
  if (/^\d{6}$/.test(dateStr)) {
    let yy = dateStr.slice(0, 2), mm = dateStr.slice(2, 4), dd = dateStr.slice(4, 6);
    flight_date = `20${yy}-${mm}-${dd}`;
  }

  // Parse route, e.g. "ABV-QUO"
  let routeLine = lines.find(l => /^[A-Z]{3,4}-[A-Z]{3,4}/.test(l));
  if (routeLine) {
    [departure, arrival] = routeLine.split("-");
    route = routeLine;
  }

  // Parse STD/ATD and remarks (look for "C/O:", "TXI:", "A/B:")
  for (let l of lines) {
    let stdMatch = l.match(/C\/O:\s*([\d]{3,4})z?/i);
    if (stdMatch) std = stdMatch[1].replace(/^(\d{2})(\d{2})$/, "$1:$2");

    let atdMatch = l.match(/A\/B:\s*([\d]{3,4})z?/i);
    if (atdMatch) atd = atdMatch[1].replace(/^(\d{2})(\d{2})$/, "$1:$2");

    // Some formats use "DEP:" or "STD:" as labels—catch those too
    let depMatch = l.match(/STD:\s*([\d]{2}):?([\d]{2})/i);
    if (depMatch) std = `${depMatch[1]}:${depMatch[2]}`;
    let actDepMatch = l.match(/ATD:\s*([\d]{2}):?([\d]{2})/i);
    if (actDepMatch) atd = `${actDepMatch[1]}:${actDepMatch[2]}`;
  }

  // Parse PAX: (77)07/70, or (77)07/77, or "PAX: 08/70"
  let paxLine = lines.find(l => /PAX[:\.]/i.test(l));
  if (paxLine) {
    let match = paxLine.match(/\(?(\d+)\)?\s*(\d{1,2})\/(\d{2,3})/);
    if (match) {
      total_pax = parseInt(match[1], 10); // e.g. 77
      infant = parseInt(match[2], 10); // e.g. 07
      capacity = parseInt(match[3], 10); // e.g. 70
    }
    // Fallback for PAX: 08/70 (Premium/Economy style)
    let match2 = paxLine.match(/PAX[:\.]\s*(\d{1,2})\/(\d{2,3})/i);
    if (match2) {
      premium = parseInt(match2[1], 10);
      economy = parseInt(match2[2], 10);
    }
  }

  // Parse "CREW:" (ignore), parse "SI:" for remarks
  for (let l of lines) {
    if (/^SI:/i.test(l)) remark = l.replace(/^SI:\s*/i, "");
    if (/^Remark[:\.]/i.test(l)) remark = l.replace(/^Remark[:\.]\s*/i, "");
    if (/^Delay Reason[:\.]/i.test(l)) delay_reason = l.replace(/^Delay Reason[:\.]\s*/i, "");
    if (/^Schedule Status[:\.]/i.test(l)) schedule_status = l.replace(/^Schedule Status[:\.]\s*/i, "");
  }

  // Compose final object
  return {
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
}

// -------- Main Handler --------
module.exports = async (req, res) => {
  // Twilio webhook sends as x-www-form-urlencoded!
  let body = req.body;
  if (typeof body === "string") {
    body = Object.fromEntries(new URLSearchParams(body));
  }

  let msg = body.Body?.trim() || "";
  let from = body.From;

  // Only handle WhatsApp
  if (!msg || !from || !from.startsWith("whatsapp:")) {
    res.status(400).send("Bad request");
    return;
  }

  // Parse message
  let parsed = parseFlightMessage(msg);
  let reply = "";
  if (!parsed || !parsed.flight_no || !parsed.flight_date) {
    reply = "❌ Error: Could not parse flight message. Check your format.";
  } else {
    // Upsert into Supabase
    const { error } = await supabase
      .from("flights")
      .upsert([parsed], { onConflict: ["flight_no", "flight_date"] });
    reply = error
      ? "❌ Error: Could not save flight record."
      : "✅ MVT message received and stored!";
  }

  // Respond via Twilio WhatsApp
  try {
    await twilioClient.messages.create({
      from: WHATSAPP_NUMBER,
      to: from,
      body: reply
    });
  } catch (err) {
    // Twilio reply failed, but always 200 to webhook (Twilio best practice)
    // Optionally log err
  }

  res.status(200).send("OK");
};

