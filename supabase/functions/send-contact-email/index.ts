import "jsr:@supabase/functions-js/edge-runtime.d.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, X-Client-Info, Apikey",
};

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response(null, {
      status: 200,
      headers: corsHeaders,
    });
  }

  try {
    const { name, email, phone, location, locationEmail, message } = await req.json();

    const RESEND_API_KEY = Deno.env.get("RESEND_API_KEY");

    // Route the message to the selected studio's own mailbox — astoria@,
    // bayside@, freshmeadows@, williamsburg@ — derived from the studio name so
    // it never depends on the locations.contact_email column being set right.
    const studioMailbox = (studioName: string): string | null => {
      const key = (studioName || "").toLowerCase().replace(/[^a-z]/g, "");
      const known = ["astoria", "bayside", "freshmeadows", "williamsburg"];
      return known.includes(key) ? `${key}@betterbodybootcamp.com` : null;
    };
    // Studio mailbox first; locationEmail then info@ only as fallbacks
    // (e.g. when the visitor didn't pick a studio).
    const TO_EMAIL = studioMailbox(location) || locationEmail || "info@betterbodybootcamp.com";

    console.log("Sending email to:", TO_EMAIL);
    console.log("From:", name, email);
    console.log("Location requested:", location);

    if (!RESEND_API_KEY) {
      throw new Error("RESEND_API_KEY not configured");
    }

    const emailBody = `
      New Contact Form Submission

      Name: ${name}
      Email: ${email}
      Phone: ${phone || "Not provided"}
      Preferred Location: ${location || "Not specified"}

      Message:
      ${message}
    `;

    const emailPayload = {
      from: "Better Body Bootcamp <noreply@betterbodybootcamp.com>",
      to: [TO_EMAIL],
      reply_to: email,
      subject: `New Contact Form Submission from ${name}`,
      text: emailBody,
      html: `
        <h2>New Contact Form Submission</h2>
        <p><strong>Name:</strong> ${name}</p>
        <p><strong>Email:</strong> <a href="mailto:${email}">${email}</a></p>
        <p><strong>Phone:</strong> ${phone || "Not provided"}</p>
        <p><strong>Preferred Location:</strong> ${location || "Not specified"}</p>
        <h3>Message:</h3>
        <p>${message.replace(/\n/g, '<br>')}</p>
      `,
    };

    console.log("Sending email with payload:", JSON.stringify(emailPayload, null, 2));

    const res = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${RESEND_API_KEY}`,
      },
      body: JSON.stringify(emailPayload),
    });

    const responseText = await res.text();
    console.log("Resend API response status:", res.status);
    console.log("Resend API response:", responseText);

    if (!res.ok) {
      console.error("Resend API error:", responseText);
      throw new Error(`Failed to send email (${res.status}): ${responseText}`);
    }

    const data = JSON.parse(responseText);
    console.log("Email sent successfully via Resend:", data);

    return new Response(
      JSON.stringify({ success: true, data }),
      {
        headers: {
          ...corsHeaders,
          "Content-Type": "application/json",
        },
      }
    );
  } catch (error) {
    return new Response(
      JSON.stringify({ success: false, error: error.message }),
      {
        status: 500,
        headers: {
          ...corsHeaders,
          "Content-Type": "application/json",
        },
      }
    );
  }
});