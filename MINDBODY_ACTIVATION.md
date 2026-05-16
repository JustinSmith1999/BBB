# MindBody Integration Activation Links

This document contains the activation URLs you need to provide to MindBody for completing your integration setup.

## Integration Endpoints

### 1. OAuth Callback URL (Redirect URI)
```
https://betterbodybootcamp1.bolt.host/.netlify/functions/mindbody-oauth-callback
```

**Purpose:** This is where MindBody will redirect users after they authorize your application.

**When to use:** Provide this URL when MindBody asks for your "Redirect URI" or "Callback URL" during OAuth setup.

**What it does:**
- Receives the authorization code from MindBody
- Stores the authorization details securely in your database
- Returns a success/error response

---

### 2. Webhook URL
```
https://betterbodybootcamp1.bolt.host/.netlify/functions/mindbody-webhook
```

**Purpose:** MindBody will send real-time event notifications to this endpoint.

**When to use:** Provide this URL when MindBody asks for your "Webhook URL" or "Event Notification URL".

**Supported Events:**
- Class bookings and cancellations
- Client profile updates
- Appointment changes
- Payment events
- Staff schedule changes

**What it does:**
- Receives webhook events from MindBody
- Stores events securely in your database
- Provides immediate acknowledgment to MindBody
- Events can be processed asynchronously

---

## Setup Instructions

### Step 1: Register Your Application with MindBody
1. Log in to your MindBody Developer Portal
2. Create a new application or select your existing application
3. Navigate to the OAuth/API settings section

### Step 2: Configure OAuth Settings
Provide these details to MindBody:
- **Redirect URI:** `https://betterbodybootcamp1.bolt.host/.netlify/functions/mindbody-oauth-callback`
- **Application Type:** Web Application
- **Grant Type:** Authorization Code

### Step 3: Configure Webhook Settings
1. In your MindBody Developer Portal, find the Webhooks section
2. Add a new webhook endpoint:
   - **URL:** `https://betterbodybootcamp1.bolt.host/.netlify/functions/mindbody-webhook`
   - **Events:** Select all relevant events you want to receive
3. Save the webhook configuration

### Step 4: Configure Environment Variables
1. Go to your Netlify site settings
2. Navigate to Environment Variables
3. Add the following (if not already present):
   - `VITE_SUPABASE_URL` - Your database URL
   - `VITE_SUPABASE_ANON_KEY` - Your database anon key
   - `SUPABASE_SERVICE_ROLE_KEY` - Your database service role key (for secure backend operations)

### Step 5: Test the Integration
After MindBody configures their side:
1. Test the OAuth flow by authorizing your application
2. Verify that the authorization code is received in your database
3. Test webhook delivery by triggering an event in MindBody
4. Check your database to confirm webhook events are being received

---

## Database Tables

Your integration uses two database tables:

### mindbody_oauth_tokens
Stores OAuth authorization codes and access tokens
- Authorization codes from MindBody OAuth flow
- Access and refresh tokens (after exchange)
- Token expiration times and status

### mindbody_webhook_events
Stores all incoming webhook events from MindBody
- Event type and full payload
- Processing status
- Timestamp and signature verification data

---

## Security Notes

1. **HTTPS Only:** All endpoints use secure HTTPS connections
2. **Database Security:** Tables are protected with Row Level Security
3. **Service Role Access:** Only your backend functions can access OAuth and webhook data
4. **Signature Verification:** Webhook endpoint captures MindBody signatures for verification
5. **CORS Configured:** Endpoints properly handle cross-origin requests
6. **Environment Variables:** Sensitive keys are stored securely in Netlify environment variables

---

## Support

If MindBody requests additional information:
- **Organization:** Your Bootcamp Business
- **Technical Contact:** Your email address
- **Environment:** Production
- **Integration Type:** Public API + OAuth 2.0 + Webhooks
- **Platform:** Bolt.host (Netlify Serverless Functions)

---

## Next Steps After Activation

Once MindBody activates your integration:

1. **Exchange Authorization Code:** Implement code to exchange the authorization code for access tokens
2. **Token Refresh:** Set up automatic refresh of access tokens before expiration
3. **Webhook Processing:** Implement handlers to process different webhook event types
4. **Error Handling:** Monitor for failed API calls or webhook processing errors
5. **Testing:** Thoroughly test all booking, cancellation, and client management flows

---

## Quick Reference

| Type | URL |
|------|-----|
| OAuth Callback | `https://betterbodybootcamp1.bolt.host/.netlify/functions/mindbody-oauth-callback` |
| Webhook | `https://betterbodybootcamp1.bolt.host/.netlify/functions/mindbody-webhook` |

---

**Generated:** 2025-11-12
**Project:** Bootcamp MindBody Integration
**Platform:** Bolt.host (Netlify)
**Environment:** Production
