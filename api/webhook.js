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

// Helper: Parse time ("HH:MM") to minutes
function parseMinutes(t) {
  if (!t || !/^([01]\d|2[0-3]):[0-5]\d$/.test(t)) return null;
  const [h, m] = t.split(":").map(Number);
  return h * 60 + m;
}

function parseFlightMessage(message) {
  message = message
    .replace(/^CORR\s*/i, "")
    .replace(/^\s*MVT\s*/i, "")
    .replace(/\r/g, "")
    .replace(/\n{2,}/g, "\n")
    .trim();

  const lines = message.split("\n").map(l => l.trim()).filter(Boolean);

  let flight_no = "", flight_date = null, aircraft = "", departure = "", arrival = "";
  let std = "", atd = "", remark = "", delay_reason = "", schedule_status = "On Schedule";
  let premium = null, economy = null, infant = null, total_pax = null, capacity = null;
  let route = "";

  let infoLine = lines.find(l => /^[A-Z]{3}\d{3}\s+\d{6}/.test(l));
  if (!infoLine) {
    console.log("❌ Could not find infoLine in message:", message);
    return null;
  }
  let [flightNo, dateStr, aircraftCode] = infoLine.split(/\s+/);
  flight_no = flightNo || "";
  aircraft = aircraftCode || "";

  if (/^\d{6}$/.test(dateStr)) {
    let yy = dateStr.slice(0, 2), mm = dateStr.slice(2, 4), dd = dateStr.slice(4, 6);
    flight_date = `20${yy}-${mm}-${dd}`;
  }

  let routeLine = lines.find(l => /^[A-Z]{3,4}-[A-Z]{3,4}/.test(l));
  if (routeLine) {
    [departure, arrival] = routeLine.split("-");
    route = `${departure}-${arrival}`;
  }

  for (let l of lines) {
    let stdMatch = l.match(/(?:C\/O|STD)[:\s]*([0-2][0-9])[:]?([0-5][0-9])?/i);
    if (stdMatch) std = stdMatch[2] ? `${stdMatch[1]}:${stdMatch[2]}` : stdMatch[1];

    let atdMatch = l.match(/(?:A\/B|ATD)[:\s]*([0-2][0-9])[:]?([0-5][0-9])?/i);
    if (atdMatch) atd = atdMatch[2] ? `${atdMatch[1]}:${atdMatch[2]}` : atdMatch[1];
  }

  let paxLine = lines.find(l => /PAX[:\.]/i.test(l));
  if (paxLine) {
    let match = paxLine.match(/\(?(\d+)\)?\s*(\d{1,2})\/(\d{2,3})(\+(\d{1,2})(inf|INF))?/);
    if (match) {
      total_pax = parseInt(match[1], 10);
      premium = parseInt(match[2], 10);
      economy = parseInt(match[3], 10);
      if (match[5]) infant = parseInt(match[5], 10);
      capacity = economy;
    } else {
      let fallback = paxLine.match(/PAX[:\.]?\s*(\d{1,2})\/(\d{2,3})/i);
      if (fallback) {
        premium = parseInt(fallback[1], 10);
        economy = parseInt(fallback[2], 10);
        capacity = economy;
      }
      let infFallback = paxLine.match(/\+(\d{1,2})(inf|INF)/);
      if (infFallback) infant = parseInt(infFallback[1], 10);
    }
  }

  // Always: total_pax = premium + economy + infant, unless original value is present and higher
  let sum_pax = 0;
  if (premium != null) sum_pax += premium;
  if (economy != null) sum_pax += economy;
  if (infant != null) sum_pax += infant;
  if (!total_pax || sum_pax > total_pax) total_pax = sum_pax;

  let dlyLine = lines.find(l => /^DLY[:\.]/i.test(l));
  if (dlyLine) {
    delay_reason = dlyLine.replace(/^DLY[:\.]\s*/i, "");
  }

  for (let l of lines) {
    if (/^SI:/i.test(l)) remark = l.replace(/^SI:\s*/i, "");
    if (/^Remark[:\.]/i.test(l)) remark = l.replace(/^Remark[:\.]\s*/i, "");
    if (/^Delay Reason[:\.]/i.test(l)) delay_reason = l.replace(/^Delay Reason[:\.]\s*/i, "");
    if (/^Schedule Status[:\.]/i.test(l)) schedule_status = l.replace(/^Schedule Status[:\.]\s*/i, "");
  }

  // Remark: based on delay between STD and ATD (if both available)
  if (std && atd) {
    let stdMins = parseMinutes(std);
    let atdMins = parseMinutes(atd);
    if (stdMins != null && atdMins != null) {
      let diff = atdMins - stdMins;
      if (diff > 15) remark = "Delayed";
      else remark = "On time";
    }
  }

  // Always recalc route
  route = `${departure}-${arrival}`;

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

// Format the field summary for WhatsApp
function buildFieldSummary(rowObj) {
  const labels = {
    flight_date: "Date",
    flight_no: "Flight No",
    aircraft: "Aircraft",
    capacity: "Capacity",
    departure: "Departure",
    arrival: "Arrival",
    route: "Route",
    std: "STD",
    atd: "ATD",
    remark: "Remark",
    delay_reason: "Delay Reason",
    schedule_status: "Schedule Status",
    premium: "Premium",
    economy: "Economy",
    infant: "Infant",
    total_pax: "Total Pax"
  };
  return Object.entries(rowObj)
    .filter(([k, v]) => v !== null && v !== undefined && v !== "")
    .map(([k, v]) => `• ${labels[k] || k}: ${v}`)
    .join("\n");
}

// -------- Main Handler --------
module.exports = async (req, res) => {
  console.log("Incoming Twilio webhook:", req.body);

  let body = req.body;
  if (typeof body === "string") {
    body = Object.fromEntries(new URLSearchParams(body));
  }

  let msg = body.Body?.trim() || "";
  let from = body.From;

  if (!msg || !from || !from.startsWith("whatsapp:")) {
    console.log("❌ Not a WhatsApp message or missing fields:", { msg, from });
    res.status(400).send("Bad request");
    return;
  }

  let parsed = parseFlightMessage(msg);
  let reply = "";

  if (!parsed || !parsed.flight_no || !parsed.flight_date) {
    console.log("❌ Parse failed. Parsed object:", parsed);
    reply = "❌ Error: Could not parse flight message. Check your format.";
  } else {
    // Step 1: Check if record exists
    const { data: existing, error: fetchError } = await supabase
      .from("flights")
      .select("uuid")
      .eq("flight_no", parsed.flight_no)
      .eq("flight_date", parsed.flight_date)
      .maybeSingle();

    if (fetchError) {
      reply = "❌ Error: Could not check for existing flight record.";
      console.log("❌ Supabase fetch error:", fetchError);
    } else {
      // Step 2: Upsert
      const { error: upsertError } = await supabase
        .from("flights")
        .upsert([parsed], { onConflict: ["flight_no", "flight_date"] });

      let fieldSummary = buildFieldSummary(parsed);
      if (upsertError) {
        reply = "❌ Error: Could not save flight record.";
        console.log("❌ Supabase upsert error:", upsertError);
      } else if (existing) {
        reply = `✏️ Existing flight record updated:\n${fieldSummary}`;
      } else {
        reply = `✅ New flight record added:\n${fieldSummary}`;
      }
    }
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
  }

  res.status(200).send("OK");
};
