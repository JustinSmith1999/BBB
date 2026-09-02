import { useEffect, useState } from 'react';
import { Quote } from 'lucide-react';
import { supabase, Testimonial } from '../lib/supabase';
import SEOHead from '../components/SEOHead';
import PageHero, { Red } from '../components/PageHero';

export default function TestimonialsPage() {
  const [testimonials, setTestimonials] = useState<Testimonial[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    window.scrollTo(0, 0);
    supabase
      .from('testimonials')
      .select('*')
      .order('display_order')
      .then(({ data }) => {
        setTestimonials(data || []);
        setLoading(false);
      })
      .catch(() => setLoading(false));
  }, []);

  const extractYouTubeId = (url: string) => {
    const match = url.match(/^.*((youtu\.be\/)|(v\/)|(\/u\/\w\/)|(embed\/)|(watch\?))\??v?=?([^#&?]*).*/);
    return match && match[7].length === 11 ? match[7] : null;
  };

  const seo = (
    <SEOHead
      title="Member Success Stories | Better Body Bootcamp Testimonials"
      description="Real members, real transformations. See how Better Body Bootcamp members across NYC have changed their bodies and their lives since 2011."
      canonical="/testimonials"
    />
  );

  if (loading) {
    return (
      <>
        {seo}
        <section style={{ backgroundColor: 'var(--bg-primary)', color: 'var(--text-primary)', minHeight: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
          <p style={{ color: 'var(--text-secondary)' }}>Loading...</p>
        </section>
      </>
    );
  }

  const videoTestimonials = testimonials.filter(t => t.video_url);
  const textTestimonials = testimonials.filter(t => !t.video_url);

  return (
    <>
      {seo}
      <div style={{ backgroundColor: 'var(--bg-primary)', color: 'var(--text-primary)' }}>

        {/* Hero (shared PageHero — one style everywhere) */}
        <PageHero
          eyebrow="REAL RESULTS · NYC"
          lines={["SUCCESS", <Red key="r">STORIES</Red>]}
        />

        {/* Video testimonials */}
        {videoTestimonials.length > 0 && (
          <section style={{ padding: '80px 0 60px' }}>
            <div className="max-w-content mx-auto px-6">
              <p className="eyebrow mb-3">WATCH</p>
              <h2
                className="font-display font-black uppercase mb-12"
                style={{ fontSize: 'clamp(1.75rem, 3vw, 2.5rem)', lineHeight: '0.95', letterSpacing: '-0.01em', color: 'var(--text-primary)' }}
              >
                Video Testimonials
              </h2>
              <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
                {videoTestimonials.map(t => (
                  <div
                    key={t.id}
                    className="group rounded-xl overflow-hidden transition-all duration-200"
                    style={{
                      backgroundColor: 'var(--bg-elevated)',
                      border: '1px solid var(--divider)',
                    }}
                    onMouseEnter={e => (e.currentTarget as HTMLDivElement).style.borderColor = 'var(--brand-red)'}
                    onMouseLeave={e => (e.currentTarget as HTMLDivElement).style.borderColor = 'var(--divider)'}
                  >
                    {/* Video embed with red overlay on hover */}
                    <div className="relative w-full overflow-hidden" style={{ paddingBottom: '56.25%', borderRadius: '12px 12px 0 0' }}>
                      <iframe
                        className="absolute top-0 left-0 w-full h-full"
                        src={`https://www.youtube.com/embed/${extractYouTubeId(t.video_url!)}`}
                        title={t.title}
                        frameBorder="0"
                        allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture"
                        allowFullScreen
                      />
                    </div>
                    <div className="p-5">
                      <h3 className="font-bold text-base mb-1" style={{ color: 'var(--text-primary)' }}>{t.title}</h3>
                      <p className="text-sm font-semibold mb-2" style={{ color: 'var(--brand-red)' }}>{t.name}</p>
                      {t.content && (
                        <p className="text-sm line-clamp-3" style={{ color: 'var(--text-secondary)', lineHeight: '1.6' }}>{t.content}</p>
                      )}
                    </div>
                  </div>
                ))}
              </div>
            </div>
          </section>
        )}

        {/* Text testimonials */}
        {textTestimonials.length > 0 && (
          <section style={{ padding: '40px 0 120px' }}>
            <div className="max-w-content mx-auto px-6">
              <p className="eyebrow mb-3">READ</p>
              <h2
                className="font-display font-black uppercase mb-12"
                style={{ fontSize: 'clamp(1.75rem, 3vw, 2.5rem)', lineHeight: '0.95', letterSpacing: '-0.01em', color: 'var(--text-primary)' }}
              >
                Written Testimonials
              </h2>
              {/* 2026-09-02: masonry via CSS columns — short reviews never sit on
                  the same stretched row as long ones. Google reviews render
                  verbatim with no title (titles read like AI summaries). */}
              <div className="columns-1 md:columns-2 lg:columns-3 gap-6">
                {textTestimonials.map(t => {
                  const isGoogle = t.name.includes('Google review');
                  return (
                  <div
                    key={t.id}
                    className="rounded-xl transition-all duration-200 break-inside-avoid mb-6"
                    style={{
                      backgroundColor: 'var(--bg-elevated)',
                      border: '1px solid var(--divider)',
                      padding: '32px',
                    }}
                    onMouseEnter={e => (e.currentTarget as HTMLDivElement).style.borderColor = 'rgba(216,59,59,0.3)'}
                    onMouseLeave={e => (e.currentTarget as HTMLDivElement).style.borderColor = 'var(--divider)'}
                  >
                    <Quote className="mb-4" style={{ color: 'var(--brand-red)', width: 28, height: 28 }} />
                    {!isGoogle && (
                      <h3 className="font-bold text-lg mb-3" style={{ color: 'var(--text-primary)' }}>{t.title}</h3>
                    )}
                    <p className="mb-5 text-sm leading-relaxed whitespace-pre-line" style={{ color: 'var(--text-secondary)', lineHeight: '1.7' }}>{t.content}</p>
                    <p className="font-bold text-sm" style={{ color: 'var(--brand-red)', letterSpacing: '0.04em' }}>{t.name}</p>
                  </div>
                  );
                })}
              </div>
            </div>
          </section>
        )}

        {testimonials.length === 0 && (
          <section style={{ padding: '120px 0', textAlign: 'center' }}>
            <p style={{ color: 'var(--text-secondary)' }}>No testimonials available yet.</p>
          </section>
        )}
      </div>
    </>
  );
}
