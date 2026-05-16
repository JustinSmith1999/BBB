import { useState, useEffect } from 'react';
import { Mail, Phone, MapPin, ArrowRight, CheckCircle } from 'lucide-react';
import { supabase, Location, ContactSubmission } from '../lib/supabase';

const inputStyle: React.CSSProperties = {
  width: '100%',
  padding: '12px 16px',
  fontSize: '14px',
  backgroundColor: 'var(--bg-primary)',
  border: '1px solid var(--divider)',
  borderRadius: '10px',
  color: 'var(--text-primary)',
  outline: 'none',
  transition: 'border-color 150ms ease',
};

const labelStyle: React.CSSProperties = {
  display: 'block',
  fontSize: '12px',
  fontWeight: 600,
  letterSpacing: '0.06em',
  textTransform: 'uppercase',
  color: 'var(--text-secondary)',
  marginBottom: '8px',
};

export default function Contact() {
  const [locations, setLocations] = useState<Location[]>([]);
  const [formData, setFormData] = useState<ContactSubmission>({
    name: '',
    email: '',
    phone: '',
    location_id: '',
    message: '',
  });
  const [loading, setLoading] = useState(false);
  const [success, setSuccess] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    supabase
      .from('locations')
      .select('*')
      .eq('is_active', true)
      .order('display_order')
      .then(({ data }) => setLocations(data || []));
  }, []);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setLoading(true);
    setError('');

    try {
      const { error: dbError } = await supabase.from('contact_submissions').insert([{
        name: formData.name,
        email: formData.email,
        phone: formData.phone,
        location_id: formData.location_id || null,
        message: formData.message,
      }]);

      if (dbError) throw dbError;

      const selectedLocation = locations.find(l => l.id === formData.location_id);

      await fetch(`${import.meta.env.VITE_SUPABASE_URL}/functions/v1/send-contact-email`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${import.meta.env.VITE_SUPABASE_ANON_KEY}`,
        },
        body: JSON.stringify({
          name: formData.name,
          email: formData.email,
          phone: formData.phone,
          location: selectedLocation?.name || 'Not specified',
          locationEmail: selectedLocation?.contact_email,
          message: formData.message,
        }),
      });

      setSuccess(true);
      setFormData({ name: '', email: '', phone: '', location_id: '', message: '' });
      setTimeout(() => setSuccess(false), 6000);
    } catch {
      setError('Failed to send message. Please try again.');
    } finally {
      setLoading(false);
    }
  };

  const handleChange = (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>) => {
    setFormData({ ...formData, [e.target.name]: e.target.value });
  };

  const onFocus = (e: React.FocusEvent<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>) => {
    e.currentTarget.style.borderColor = 'var(--brand-red)';
  };
  const onBlur = (e: React.FocusEvent<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>) => {
    e.currentTarget.style.borderColor = 'var(--divider)';
  };

  return (
    <section
      id="contact"
      style={{
        backgroundColor: 'var(--bg-elevated)',
        borderTop: '1px solid var(--divider)',
        padding: '96px 0',
      }}
    >
      <div className="max-w-6xl mx-auto px-6">

        {/* Header */}
        <div className="mb-14">
          <p className="eyebrow mb-3" style={{ letterSpacing: '0.2em' }}>CONTACT</p>
          <div className="flex flex-col sm:flex-row sm:items-end sm:justify-between gap-4">
            <h2
              className="font-display font-black uppercase"
              style={{
                fontSize: 'clamp(1.75rem, 4vw, 3.5rem)',
                lineHeight: '0.95',
                letterSpacing: '-0.01em',
                color: 'var(--text-primary)',
              }}
            >
              GET IN <span style={{ color: 'var(--brand-red)' }}>TOUCH</span>
            </h2>
            <p style={{ fontSize: '14px', color: 'var(--text-secondary)', maxWidth: '40ch', lineHeight: '1.5' }}>
              Questions about membership or classes? We respond within one business day.
            </p>
          </div>
        </div>

        <div className="grid grid-cols-1 lg:grid-cols-5 gap-10">

          {/* Left — info */}
          <div className="lg:col-span-2 flex flex-col gap-8">
            <div className="space-y-5">
              {[
                { icon: Phone, label: 'Call Us', desc: 'Reach out to your preferred location directly' },
                { icon: Mail, label: 'Email Us', desc: 'Use the form and we\'ll reply shortly' },
                { icon: MapPin, label: 'Visit Us', desc: 'Four NYC studios — find one near you' },
              ].map(({ icon: Icon, label, desc }) => (
                <div key={label} className="flex items-start gap-4">
                  <div
                    className="flex-shrink-0 flex items-center justify-center rounded-xl"
                    style={{ width: '42px', height: '42px', backgroundColor: 'var(--bg-primary)', border: '1px solid var(--divider)' }}
                  >
                    <Icon style={{ width: '16px', height: '16px', color: 'var(--brand-red)' }} />
                  </div>
                  <div>
                    <p style={{ fontSize: '13px', fontWeight: 700, color: 'var(--text-primary)', marginBottom: '3px' }}>{label}</p>
                    <p style={{ fontSize: '12px', color: 'var(--text-secondary)', lineHeight: '1.5' }}>{desc}</p>
                  </div>
                </div>
              ))}
            </div>

            {locations.length > 0 && (
              <div
                className="rounded-2xl"
                style={{ backgroundColor: 'var(--bg-primary)', border: '1px solid var(--divider)', padding: '20px' }}
              >
                <p
                  className="font-display font-black uppercase"
                  style={{ fontSize: '11px', letterSpacing: '0.12em', color: 'var(--text-secondary)', marginBottom: '14px' }}
                >
                  Studios
                </p>
                <div className="space-y-3">
                  {locations.map((loc) => (
                    <div key={loc.id} style={{ borderBottom: '1px solid var(--divider)', paddingBottom: '12px' }}>
                      <p style={{ fontSize: '13px', fontWeight: 700, color: 'var(--brand-red)', marginBottom: '3px' }}>{loc.name}</p>
                      <p style={{ fontSize: '11px', color: 'var(--text-secondary)' }}>{loc.address}, {loc.city}</p>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </div>

          {/* Right — form */}
          <div className="lg:col-span-3">
            <div
              className="rounded-2xl"
              style={{ backgroundColor: 'var(--bg-primary)', border: '1px solid var(--divider)', padding: '36px' }}
            >
              {success ? (
                <div className="flex flex-col items-center justify-center text-center py-10">
                  <CheckCircle style={{ width: '48px', height: '48px', color: '#22c55e', marginBottom: '16px' }} />
                  <h3
                    className="font-display font-black uppercase"
                    style={{ fontSize: '1.5rem', letterSpacing: '-0.01em', color: 'var(--text-primary)', marginBottom: '10px' }}
                  >
                    MESSAGE SENT
                  </h3>
                  <p style={{ fontSize: '14px', color: 'var(--text-secondary)', lineHeight: '1.6', maxWidth: '34ch' }}>
                    We'll get back to you within one business day.
                  </p>
                </div>
              ) : (
                <form onSubmit={handleSubmit} className="space-y-5">
                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-5">
                    <div>
                      <label htmlFor="h-name" style={labelStyle}>Full Name *</label>
                      <input
                        id="h-name" name="name" type="text" required
                        value={formData.name} onChange={handleChange}
                        placeholder="Jane Smith"
                        style={inputStyle}
                        onFocus={onFocus} onBlur={onBlur}
                      />
                    </div>
                    <div>
                      <label htmlFor="h-email" style={labelStyle}>Email *</label>
                      <input
                        id="h-email" name="email" type="email" required
                        value={formData.email} onChange={handleChange}
                        placeholder="jane@example.com"
                        style={inputStyle}
                        onFocus={onFocus} onBlur={onBlur}
                      />
                    </div>
                  </div>

                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-5">
                    <div>
                      <label htmlFor="h-phone" style={labelStyle}>Phone</label>
                      <input
                        id="h-phone" name="phone" type="tel"
                        value={formData.phone} onChange={handleChange}
                        placeholder="(555) 123-4567"
                        style={inputStyle}
                        onFocus={onFocus} onBlur={onBlur}
                      />
                    </div>
                    <div>
                      <label htmlFor="h-location" style={labelStyle}>Location</label>
                      <select
                        id="h-location" name="location_id"
                        value={formData.location_id} onChange={handleChange}
                        style={{ ...inputStyle, cursor: 'pointer' }}
                        onFocus={onFocus} onBlur={onBlur}
                      >
                        <option value="">Select a location</option>
                        {locations.map((loc) => (
                          <option key={loc.id} value={loc.id}>{loc.name}</option>
                        ))}
                      </select>
                    </div>
                  </div>

                  <div>
                    <label htmlFor="h-message" style={labelStyle}>Message *</label>
                    <textarea
                      id="h-message" name="message" required rows={4}
                      value={formData.message} onChange={handleChange}
                      placeholder="Tell us how we can help you..."
                      style={{ ...inputStyle, resize: 'none' }}
                      onFocus={onFocus} onBlur={onBlur}
                    />
                  </div>

                  {error && (
                    <div
                      className="rounded-xl px-4 py-3"
                      style={{ backgroundColor: 'rgba(216,59,59,0.12)', border: '1px solid rgba(216,59,59,0.3)', color: 'var(--brand-red)', fontSize: '13px' }}
                    >
                      {error}
                    </div>
                  )}

                  <button
                    type="submit"
                    disabled={loading}
                    className="w-full font-display font-bold uppercase inline-flex items-center justify-center gap-2"
                    style={{
                      backgroundColor: 'var(--brand-red)',
                      color: '#fff',
                      borderRadius: '999px',
                      padding: '15px 32px',
                      fontSize: '13px',
                      letterSpacing: '0.06em',
                      border: 'none',
                      cursor: loading ? 'not-allowed' : 'pointer',
                      opacity: loading ? 0.7 : 1,
                      transition: 'background-color 150ms ease',
                    }}
                    onMouseEnter={e => { if (!loading) e.currentTarget.style.backgroundColor = 'var(--brand-red-hover)'; }}
                    onMouseLeave={e => { if (!loading) e.currentTarget.style.backgroundColor = 'var(--brand-red)'; }}
                  >
                    {loading ? 'Sending...' : (
                      <>Send Message <ArrowRight style={{ width: '13px', height: '13px' }} /></>
                    )}
                  </button>
                </form>
              )}
            </div>
          </div>

        </div>
      </div>
    </section>
  );
}
