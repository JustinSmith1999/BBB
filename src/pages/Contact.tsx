import { useState, useEffect } from 'react';
import { MapPin, Phone, Mail, ArrowRight, CheckCircle } from 'lucide-react';
import { supabase, LOCATION_PUBLIC_COLUMNS, Location, ContactSubmission } from '../lib/supabase';
import { getUtmParams } from '../lib/utm';
import SEOHead from '../components/SEOHead';
import PageHero, { Red } from '../components/PageHero';

export default function ContactPage() {
  const [locations, setLocations] = useState<Location[]>([]);
  const [formData, setFormData] = useState<ContactSubmission>({
    name: '', email: '', phone: '', location_id: '', message: '',
  });
  const [loading, setLoading] = useState(false);
  const [success, setSuccess] = useState(false);
  const [error, setError] = useState('');
  const [focused, setFocused] = useState<string | null>(null);

  useEffect(() => {
    supabase
      .from('locations')
      .select(LOCATION_PUBLIC_COLUMNS)
      .eq('is_active', true)
      .order('display_order')
      .then(({ data }) => setLocations(data || []));
  }, []);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setLoading(true);
    setError('');
    try {
      const { error: dbErr } = await supabase.from('contact_submissions').insert([{
        name: formData.name,
        email: formData.email,
        phone: formData.phone,
        location_id: formData.location_id || null,
        message: formData.message,
      }]);
      if (dbErr) throw dbErr;

      const selectedLocation = locations.find(l => l.id === formData.location_id);
      await fetch(`${import.meta.env.VITE_SUPABASE_URL}/functions/v1/send-contact-email`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${import.meta.env.VITE_SUPABASE_ANON_KEY}`,
        },
        body: JSON.stringify({
          name: formData.name,
          email: formData.email,
          phone: formData.phone,
          location: selectedLocation?.name || 'Not specified',
          locationEmail: selectedLocation?.contact_email,
          message: formData.message,
          ...(() => { const u = getUtmParams(); return { utm_source: u.utmSource, utm_medium: u.utmMedium, utm_campaign: u.utmCampaign, utm_content: u.utmContent }; })(),
        }),
      });

      setSuccess(true);
      setFormData({ name: '', email: '', phone: '', location_id: '', message: '' });
      setTimeout(() => setSuccess(false), 8000);
    } catch {
      setError('Something went wrong. Please try again or call your nearest studio.');
    } finally {
      setLoading(false);
    }
  };

  const handleChange = (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>) => {
    setFormData({ ...formData, [e.target.name]: e.target.value });
  };

  const fieldStyle = (name: string): React.CSSProperties => ({
    width: '100%',
    padding: '14px 18px',
    fontSize: '14px',
    fontFamily: 'inherit',
    backgroundColor: 'var(--bg-primary)',
    border: `1px solid ${focused === name ? 'var(--brand-red)' : 'var(--divider)'}`,
    borderRadius: '12px',
    color: 'var(--text-primary)',
    outline: 'none',
    transition: 'border-color 150ms ease',
  });

  return (
    <>
      <SEOHead
        title="Contact Us | Better Body Bootcamp NYC"
        description="Get in touch with Better Body Bootcamp. Contact our Astoria, Bayside, Fresh Meadows, or Williamsburg locations. We'll help you start your fitness journey."
        canonical="/contact"
      />

      <div style={{ minHeight: '100vh', backgroundColor: 'var(--bg-primary)' }}>

        {/* ── Hero (shared PageHero — one style everywhere) ── */}
        {/* 2026-09-02 (owner): one line, not stacked, and less dead air. */}
        <PageHero
          eyebrow="WE'D LOVE TO HEAR FROM YOU"
          lines={[<span key="l">LET'S <Red>TALK</Red></span>]}
          sub="Questions about our classes, memberships, or getting started? Drop us a message and we'll get back to you fast."
        />

        {/* ── Body ── */}
        <section style={{ padding: '48px 0 96px' }}>
          <div className="max-w-6xl mx-auto px-6">
            <div className="grid grid-cols-1 lg:grid-cols-5 gap-10 items-start">

              {/* ── Left panel ── */}
              <div className="lg:col-span-2 flex flex-col gap-6">

                {/* Contact methods */}
                <div
                  className="rounded-2xl p-8"
                  style={{ backgroundColor: 'var(--bg-elevated)', border: '1px solid var(--divider)' }}
                >
                  <h2
                    className="font-display font-black uppercase mb-6"
                    style={{ fontSize: '1.15rem', letterSpacing: '-0.01em', color: 'var(--text-primary)' }}
                  >
                    WAYS TO REACH US
                  </h2>
                  <div className="space-y-6">
                    {[
                      {
                        icon: Phone,
                        title: 'Call a studio',
                        body: 'Call directly for the fastest response — we pick up.',
                      },
                      {
                        icon: Mail,
                        title: 'Send a message',
                        body: 'Fill out the form and we reply within one business day.',
                      },
                      {
                        icon: MapPin,
                        title: 'Walk in',
                        body: 'Stop by any of our four NYC studios — always open arms.',
                      },
                    ].map(({ icon: Icon, title, body }) => (
                      <div key={title} className="flex items-start gap-4">
                        <div
                          className="flex-shrink-0 flex items-center justify-center rounded-xl"
                          style={{
                            width: '42px', height: '42px',
                            backgroundColor: 'rgba(216,59,59,0.10)',
                            border: '1px solid rgba(216,59,59,0.2)',
                          }}
                        >
                          <Icon style={{ width: '17px', height: '17px', color: 'var(--brand-red)' }} />
                        </div>
                        <div>
                          <p style={{ fontSize: '13px', fontWeight: 700, color: 'var(--text-primary)', marginBottom: '3px' }}>{title}</p>
                          <p style={{ fontSize: '12px', color: 'var(--text-secondary)', lineHeight: '1.55' }}>{body}</p>
                        </div>
                      </div>
                    ))}
                  </div>
                </div>

                {/* Studio list */}
                {locations.length > 0 && (
                  <div
                    className="rounded-2xl p-8"
                    style={{ backgroundColor: 'var(--bg-elevated)', border: '1px solid var(--divider)' }}
                  >
                    <h2
                      className="font-display font-black uppercase mb-5"
                      style={{ fontSize: '1.15rem', letterSpacing: '-0.01em', color: 'var(--text-primary)' }}
                    >
                      OUR STUDIOS
                    </h2>
                    <div className="space-y-5">
                      {locations.map((loc, i) => (
                        <div
                          key={loc.id}
                          style={{
                            paddingBottom: i < locations.length - 1 ? '20px' : 0,
                            borderBottom: i < locations.length - 1 ? '1px solid var(--divider)' : 'none',
                          }}
                        >
                          <p style={{ fontSize: '14px', fontWeight: 800, color: 'var(--text-primary)', marginBottom: '4px' }}>{loc.name}</p>
                          <p style={{ fontSize: '12px', color: 'var(--text-secondary)', lineHeight: '1.5', marginBottom: '2px' }}>
                            {loc.address}, {loc.city}, {loc.state} {loc.zip}
                          </p>
                          {loc.phone && (
                            <a
                              href={`tel:${loc.phone.replace(/[^0-9]/g, '')}`}
                              style={{ fontSize: '12px', color: 'var(--brand-red)', textDecoration: 'none', fontWeight: 600 }}
                            >
                              {loc.phone}
                            </a>
                          )}
                        </div>
                      ))}
                    </div>
                  </div>
                )}
              </div>

              {/* ── Form panel ── */}
              <div className="lg:col-span-3">
                <div
                  className="rounded-2xl"
                  style={{ backgroundColor: 'var(--bg-elevated)', border: '1px solid var(--divider)', overflow: 'hidden' }}
                >
                  {/* Panel header */}
                  <div
                    style={{
                      padding: '28px 36px',
                      borderBottom: '1px solid var(--divider)',
                    }}
                  >
                    <h2
                      className="font-display font-black uppercase"
                      style={{ fontSize: '1.25rem', letterSpacing: '-0.01em', color: 'var(--text-primary)', marginBottom: '4px' }}
                    >
                      SEND US A MESSAGE
                    </h2>
                    <p style={{ fontSize: '13px', color: 'var(--text-secondary)' }}>
                      All fields marked * are required.
                    </p>
                  </div>

                  <div style={{ padding: '36px' }}>
                    {success ? (
                      <div
                        className="flex flex-col items-center justify-center text-center"
                        style={{ padding: '48px 0' }}
                      >
                        <div
                          className="flex items-center justify-center rounded-full mb-5"
                          style={{ width: '64px', height: '64px', backgroundColor: 'rgba(34,197,94,0.12)', border: '1px solid rgba(34,197,94,0.3)' }}
                        >
                          <CheckCircle style={{ width: '32px', height: '32px', color: '#22c55e' }} />
                        </div>
                        <h3
                          className="font-display font-black uppercase mb-3"
                          style={{ fontSize: '1.75rem', letterSpacing: '-0.01em', lineHeight: '1', color: 'var(--text-primary)' }}
                        >
                          MESSAGE SENT
                        </h3>
                        <p style={{ fontSize: '14px', color: 'var(--text-secondary)', lineHeight: '1.65', maxWidth: '34ch' }}>
                          Thanks for reaching out. We'll get back to you within one business day.
                        </p>
                      </div>
                    ) : (
                      <form onSubmit={handleSubmit} className="space-y-5">
                        {/* Row 1 */}
                        <div className="grid grid-cols-1 sm:grid-cols-2 gap-5">
                          <div>
                            <label style={{ display: 'block', fontSize: '11px', fontWeight: 700, letterSpacing: '0.1em', textTransform: 'uppercase', color: 'var(--text-secondary)', marginBottom: '8px' }}>
                              Full Name *
                            </label>
                            <input
                              type="text" name="name" required
                              value={formData.name} onChange={handleChange}
                              placeholder="Jane Smith"
                              style={fieldStyle('name')}
                              onFocus={() => setFocused('name')}
                              onBlur={() => setFocused(null)}
                            />
                          </div>
                          <div>
                            <label style={{ display: 'block', fontSize: '11px', fontWeight: 700, letterSpacing: '0.1em', textTransform: 'uppercase', color: 'var(--text-secondary)', marginBottom: '8px' }}>
                              Email Address *
                            </label>
                            <input
                              type="email" name="email" required
                              value={formData.email} onChange={handleChange}
                              placeholder="jane@example.com"
                              style={fieldStyle('email')}
                              onFocus={() => setFocused('email')}
                              onBlur={() => setFocused(null)}
                            />
                          </div>
                        </div>

                        {/* Row 2 */}
                        <div className="grid grid-cols-1 sm:grid-cols-2 gap-5">
                          <div>
                            <label style={{ display: 'block', fontSize: '11px', fontWeight: 700, letterSpacing: '0.1em', textTransform: 'uppercase', color: 'var(--text-secondary)', marginBottom: '8px' }}>
                              Phone Number
                            </label>
                            <input
                              type="tel" name="phone"
                              value={formData.phone} onChange={handleChange}
                              placeholder="(555) 123-4567"
                              style={fieldStyle('phone')}
                              onFocus={() => setFocused('phone')}
                              onBlur={() => setFocused(null)}
                            />
                          </div>
                          <div>
                            <label style={{ display: 'block', fontSize: '11px', fontWeight: 700, letterSpacing: '0.1em', textTransform: 'uppercase', color: 'var(--text-secondary)', marginBottom: '8px' }}>
                              Preferred Studio
                            </label>
                            <select
                              name="location_id"
                              value={formData.location_id} onChange={handleChange}
                              style={{ ...fieldStyle('location'), cursor: 'pointer' }}
                              onFocus={() => setFocused('location')}
                              onBlur={() => setFocused(null)}
                            >
                              <option value="">Select a location</option>
                              {locations.map(loc => (
                                <option key={loc.id} value={loc.id}>{loc.name}</option>
                              ))}
                            </select>
                          </div>
                        </div>

                        {/* Message */}
                        <div>
                          <label style={{ display: 'block', fontSize: '11px', fontWeight: 700, letterSpacing: '0.1em', textTransform: 'uppercase', color: 'var(--text-secondary)', marginBottom: '8px' }}>
                            Your Message *
                          </label>
                          <textarea
                            name="message" required rows={5}
                            value={formData.message} onChange={handleChange}
                            placeholder="Tell us how we can help you get started..."
                            style={{ ...fieldStyle('message'), resize: 'none' }}
                            onFocus={() => setFocused('message')}
                            onBlur={() => setFocused(null)}
                          />
                        </div>

                        {/* Error */}
                        {error && (
                          <div
                            className="rounded-xl px-5 py-3.5"
                            style={{
                              backgroundColor: 'rgba(216,59,59,0.10)',
                              border: '1px solid rgba(216,59,59,0.25)',
                              color: 'var(--brand-red)',
                              fontSize: '13px',
                              lineHeight: '1.5',
                            }}
                          >
                            {error}
                          </div>
                        )}

                        {/* Submit */}
                        <button
                          type="submit"
                          disabled={loading}
                          className="w-full font-display font-bold uppercase inline-flex items-center justify-center gap-2"
                          style={{
                            backgroundColor: loading ? 'var(--brand-red-hover)' : 'var(--brand-red)',
                            color: '#fff',
                            borderRadius: '999px',
                            padding: '17px 32px',
                            fontSize: '14px',
                            letterSpacing: '0.07em',
                            border: 'none',
                            cursor: loading ? 'not-allowed' : 'pointer',
                            opacity: loading ? 0.75 : 1,
                            transition: 'background-color 150ms ease, transform 150ms ease',
                          }}
                          onMouseEnter={e => { if (!loading) { e.currentTarget.style.backgroundColor = 'var(--brand-red-hover)'; e.currentTarget.style.transform = 'translateY(-1px)'; } }}
                          onMouseLeave={e => { if (!loading) { e.currentTarget.style.backgroundColor = 'var(--brand-red)'; e.currentTarget.style.transform = 'none'; } }}
                        >
                          {loading ? 'Sending…' : <>Send Message <ArrowRight style={{ width: '14px', height: '14px' }} /></>}
                        </button>

                        <p style={{ fontSize: '12px', color: 'var(--text-secondary)', textAlign: 'center', lineHeight: '1.5' }}>
                          We respond within one business day. You can also call any studio directly.
                        </p>
                      </form>
                    )}
                  </div>
                </div>
              </div>

            </div>
          </div>
        </section>

        {/* ── Bottom strip ── */}
        <section style={{ borderTop: '1px solid var(--divider)', padding: '80px 0' }}>
          <div className="max-w-2xl mx-auto px-6 text-center">
            <h2
              className="font-display font-black uppercase mb-4"
              style={{ fontSize: 'clamp(1.5rem, 3vw, 2.5rem)', lineHeight: '0.95', letterSpacing: '-0.01em', color: 'var(--text-primary)' }}
            >
              READY TO JUST START?
            </h2>
            <p style={{ color: 'var(--text-secondary)', fontSize: '15px', marginBottom: '32px', lineHeight: '1.65' }}>
              Skip the questions — grab our 2-week trial and experience it for yourself.
            </p>
            <a
              href="/trial"
              className="font-display font-bold uppercase inline-flex items-center gap-2"
              style={{
                backgroundColor: 'var(--brand-red)',
                color: '#fff',
                borderRadius: '999px',
                padding: '16px 36px',
                fontSize: '14px',
                letterSpacing: '0.06em',
                textDecoration: 'none',
                transition: 'background-color 150ms ease, transform 150ms ease',
              }}
              onMouseEnter={e => { e.currentTarget.style.backgroundColor = 'var(--brand-red-hover)'; e.currentTarget.style.transform = 'translateY(-2px)'; }}
              onMouseLeave={e => { e.currentTarget.style.backgroundColor = 'var(--brand-red)'; e.currentTarget.style.transform = 'none'; }}
            >
              Start 2-Week Trial — $49
              <ArrowRight style={{ width: '14px', height: '14px' }} />
            </a>
          </div>
        </section>

      </div>
    </>
  );
}
