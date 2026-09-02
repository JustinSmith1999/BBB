import { Check, Zap, Dumbbell, Heart, Flame, ArrowRight } from 'lucide-react';
import { useNavigate } from 'react-router-dom';
import SEOHead from '../components/SEOHead';
import PageHero, { Red } from '../components/PageHero';

const plans = [
  {
    id: 'trial',
    label: 'Get Started',
    name: '2-Week Trial',
    price: '$49',
    period: 'one time',
    description: 'The best way to experience Better Body. Two full weeks, unlimited classes.',
    highlight: false,
    badge: null,
    features: [
      'Unlimited classes for 2 weeks',
      'All 4 NYC locations',
      'Expert-led group training',
      'Nutrition kick-start guide',
      'No commitment required',
    ],
    cta: 'Start Your Trial',
    ctaAction: 'trial',
  },
  {
    id: 'monthly',
    label: 'Most Popular',
    name: 'Monthly Membership',
    price: 'Contact Us',
    period: 'per month',
    description: 'Full access, no lock-in. The choice for members who want complete flexibility.',
    highlight: true,
    badge: 'MOST POPULAR',
    features: [
      'Unlimited classes every month',
      'All 4 NYC locations',
      'Expert-led group training',
      'Nutrition coaching & guidance',
      'Community & accountability',
      'App-based class scheduling',
    ],
    cta: 'Get Monthly Pricing',
    ctaAction: 'contact',
  },
  {
    id: 'annual',
    label: 'Best Value',
    name: 'Annual Membership',
    price: 'Contact Us',
    period: 'per year',
    description: 'Commit to the year, get our best rate. For members serious about transformation.',
    highlight: false,
    badge: 'BEST VALUE',
    features: [
      'Everything in Monthly',
      'Lowest per-month rate',
      'Priority class booking',
      'Exclusive member events',
      'Annual progress review',
      'Dedicated member support',
    ],
    cta: 'Get Annual Pricing',
    ctaAction: 'contact',
  },
];

const pillars = [
  {
    icon: Zap,
    title: 'The Full Solution',
    body: "Your reasons for getting in shape are deep and meaningful — we treat your results like a matter of life and death. The best trainers, the most effective workouts, and the most fun environment in all of fitness.",
  },
  {
    icon: Flame,
    title: 'Fat-Burning Intervals',
    body: "We take interval training to a higher level. Our intervals sculpt and tone while burning fat — changing your shape, not just your heart rate. There's more to results than endless burpees.",
  },
  {
    icon: Dumbbell,
    title: 'Body Sculpting With Weights',
    body: "The wrong strength routine can make you look worse. We pick moves that sculpt, tone, and define you — in combinations designed to give you the best possible appearance.",
  },
  {
    icon: Heart,
    title: 'Fun Makes It Effortless',
    body: "Training that pumps energy, motivation, and fun into every session. You'll look forward to every workout. It's how we've turned more newbies into fitness junkies than any other program.",
  },
];

export default function PricingPage() {
  const navigate = useNavigate();

  const handleCta = (action: string) => {
    if (action === 'trial') {
      navigate('/trial');
    } else {
      navigate('/contact');
    }
  };

  return (
    <>
      <SEOHead
        title="Pricing & Membership | Better Body Bootcamp NYC"
        description="Flexible membership options at Better Body Bootcamp. 2-week trial for $49, monthly and annual memberships. 4 NYC locations."
        canonical="/pricing"
      />

      <div className="min-h-screen" style={{ backgroundColor: 'var(--bg-primary)' }}>

        {/* ── Hero (shared PageHero — one style everywhere) ── */}
        <PageHero
          eyebrow="MEMBERSHIP · NYC"
          lines={["INVEST IN", <Red key="r">YOUR BODY</Red>]}
          sub="Simple, transparent options — from a two-week trial to a full annual commitment. Start whenever you're ready."
        />

        {/* ── Plans ── */}
        <section style={{ padding: '96px 0' }}>
          <div className="max-w-content mx-auto px-6">
            <div className="grid grid-cols-1 md:grid-cols-3 gap-8 items-stretch">
              {plans.map((plan) => (
                <div
                  key={plan.id}
                  className="relative flex flex-col rounded-2xl overflow-hidden transition-transform duration-300"
                  style={{
                    backgroundColor: plan.highlight ? 'var(--brand-red)' : 'var(--bg-elevated)',
                    border: plan.highlight
                      ? '1px solid var(--brand-red)'
                      : '1px solid var(--divider)',
                    transform: plan.highlight ? 'scale(1.03)' : 'scale(1)',
                  }}
                  onMouseEnter={e => {
                    if (!plan.highlight) (e.currentTarget as HTMLDivElement).style.borderColor = 'var(--brand-red)';
                  }}
                  onMouseLeave={e => {
                    if (!plan.highlight) (e.currentTarget as HTMLDivElement).style.borderColor = 'var(--divider)';
                  }}
                >
                  {/* Badge */}
                  {plan.badge && (
                    <div
                      className="absolute top-5 right-5"
                    >
                      <span
                        className="font-display font-black uppercase"
                        style={{
                          fontSize: '10px',
                          letterSpacing: '0.1em',
                          backgroundColor: plan.highlight ? '#fff' : 'var(--brand-red)',
                          color: plan.highlight ? 'var(--brand-red)' : '#fff',
                          borderRadius: '999px',
                          padding: '4px 12px',
                        }}
                      >
                        {plan.badge}
                      </span>
                    </div>
                  )}

                  <div className="flex flex-col flex-1 p-8">
                    {/* Plan label */}
                    <p
                      className="uppercase font-semibold mb-3"
                      style={{
                        fontSize: '11px',
                        letterSpacing: '0.15em',
                        color: plan.highlight ? 'rgba(255,255,255,0.75)' : 'var(--text-secondary)',
                      }}
                    >
                      {plan.label}
                    </p>

                    {/* Plan name */}
                    <h2
                      className="font-display font-black uppercase mb-4"
                      style={{
                        fontSize: 'clamp(1.25rem, 2vw, 1.75rem)',
                        lineHeight: '1.0',
                        letterSpacing: '-0.01em',
                        color: plan.highlight ? '#fff' : 'var(--text-primary)',
                      }}
                    >
                      {plan.name}
                    </h2>

                    {/* Price */}
                    <div className="mb-4">
                      <span
                        className="font-display font-black"
                        style={{
                          fontSize: plan.price === 'Contact Us' ? '1.75rem' : 'clamp(2rem, 4vw, 3rem)',
                          color: plan.highlight ? '#fff' : 'var(--text-primary)',
                          lineHeight: '1',
                        }}
                      >
                        {plan.price}
                      </span>
                      {plan.price !== 'Contact Us' && (
                        <span
                          className="ml-2 text-sm"
                          style={{ color: plan.highlight ? 'rgba(255,255,255,0.7)' : 'var(--text-secondary)' }}
                        >
                          {plan.period}
                        </span>
                      )}
                    </div>

                    {/* Description */}
                    <p
                      className="text-sm mb-8"
                      style={{
                        color: plan.highlight ? 'rgba(255,255,255,0.8)' : 'var(--text-secondary)',
                        lineHeight: '1.6',
                      }}
                    >
                      {plan.description}
                    </p>

                    {/* Divider */}
                    <div
                      className="mb-8"
                      style={{
                        height: '1px',
                        backgroundColor: plan.highlight ? 'rgba(255,255,255,0.2)' : 'var(--divider)',
                      }}
                    />

                    {/* Features */}
                    <ul className="space-y-3 mb-10 flex-1">
                      {plan.features.map((f) => (
                        <li key={f} className="flex items-start gap-3">
                          <Check
                            className="flex-shrink-0 mt-0.5"
                            style={{
                              width: '16px',
                              height: '16px',
                              color: plan.highlight ? '#fff' : 'var(--brand-red)',
                            }}
                          />
                          <span
                            className="text-sm"
                            style={{
                              color: plan.highlight ? 'rgba(255,255,255,0.9)' : 'var(--text-secondary)',
                            }}
                          >
                            {f}
                          </span>
                        </li>
                      ))}
                    </ul>

                    {/* CTA */}
                    <button
                      onClick={() => handleCta(plan.ctaAction)}
                      className="w-full font-display font-bold uppercase flex items-center justify-center gap-2 transition-all duration-150"
                      style={{
                        borderRadius: '999px',
                        padding: '14px 24px',
                        fontSize: '13px',
                        letterSpacing: '0.06em',
                        backgroundColor: plan.highlight ? '#fff' : 'var(--brand-red)',
                        color: plan.highlight ? 'var(--brand-red)' : '#fff',
                        border: 'none',
                        cursor: 'pointer',
                      }}
                      onMouseEnter={e => {
                        const el = e.currentTarget;
                        el.style.opacity = '0.9';
                        el.style.transform = 'translateY(-1px)';
                      }}
                      onMouseLeave={e => {
                        const el = e.currentTarget;
                        el.style.opacity = '1';
                        el.style.transform = 'none';
                      }}
                    >
                      {plan.cta}
                      <ArrowRight style={{ width: '14px', height: '14px' }} />
                    </button>
                  </div>
                </div>
              ))}
            </div>

            {/* Fine print */}
            <p
              className="text-center mt-8 text-sm"
              style={{ color: 'var(--text-secondary)' }}
            >
              Pricing may vary by location — contact your nearest studio for details.
            </p>
          </div>
        </section>

        {/* ── Why BBB ── */}
        <section
          style={{
            borderTop: '1px solid var(--divider)',
            padding: '96px 0',
          }}
        >
          <div className="max-w-content mx-auto px-6">
            <div className="text-center mb-16">
              <p className="eyebrow mb-4" style={{ letterSpacing: '0.2em' }}>THE PROGRAM</p>
              <h2
                className="font-display font-black uppercase"
                style={{
                  fontSize: 'clamp(1.75rem, 4vw, 3.5rem)',
                  lineHeight: '0.95',
                  letterSpacing: '-0.01em',
                  color: 'var(--text-primary)',
                }}
              >
                WHY BETTER BODY<br />
                <span style={{ color: 'var(--brand-red)' }}>GETS RESULTS</span>
              </h2>
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-6">
              {pillars.map(({ icon: Icon, title, body }) => (
                <div
                  key={title}
                  className="rounded-2xl p-8 transition-all duration-200 group"
                  style={{
                    backgroundColor: 'var(--bg-elevated)',
                    border: '1px solid var(--divider)',
                  }}
                  onMouseEnter={e => (e.currentTarget as HTMLDivElement).style.borderColor = 'var(--brand-red)'}
                  onMouseLeave={e => (e.currentTarget as HTMLDivElement).style.borderColor = 'var(--divider)'}
                >
                  <div
                    className="inline-flex items-center justify-center rounded-xl mb-5 transition-transform duration-200 group-hover:scale-110"
                    style={{
                      width: '48px',
                      height: '48px',
                      backgroundColor: 'rgba(216,59,59,0.12)',
                    }}
                  >
                    <Icon style={{ width: '22px', height: '22px', color: 'var(--brand-red)' }} />
                  </div>
                  <h3
                    className="font-display font-black uppercase mb-3"
                    style={{
                      fontSize: '1.1rem',
                      letterSpacing: '-0.01em',
                      color: 'var(--text-primary)',
                    }}
                  >
                    {title}
                  </h3>
                  <p
                    className="text-sm leading-relaxed"
                    style={{ color: 'var(--text-secondary)' }}
                  >
                    {body}
                  </p>
                </div>
              ))}
            </div>
          </div>
        </section>

        {/* SEO content block (2026-08-23): pricing cards alone left this page
            thin in the served HTML. How pricing actually works, brand voice. */}
        <section style={{ borderTop: '1px solid var(--divider)', padding: '64px 0' }}>
          <div className="max-w-6xl mx-auto px-6" style={{ color: 'var(--text-secondary)', fontSize: '15px', lineHeight: '1.7' }}>
            <h2
              className="font-display font-black uppercase mb-5"
              style={{ fontSize: 'clamp(1.25rem, 2.5vw, 1.75rem)', color: 'var(--text-primary)' }}
            >
              How Pricing Works Here
            </h2>
            <p style={{ marginBottom: '16px' }}>
              Everyone starts the same way: the $49 two-week trial. It's unlimited classes at your home studio,
              it's a one-time charge, and it does not roll into anything automatically. We built it that way on
              purpose. Two weeks is enough time to train six or eight sessions, meet the coaches, and know
              whether this is your gym before you commit to a membership.
            </p>
            <p style={{ marginBottom: '16px' }}>
              After the trial, memberships are unlimited classes across all four studios: Astoria, Bayside, and
              Fresh Meadows in Queens plus Williamsburg in Brooklyn. There are no per-class charges and no
              booking fees. Month-to-month and paid-in-full options exist at different price points, and the
              front desk will lay out exact numbers for your studio without games. Class cancellations are free
              up to 2 hours before start time through the Better Body Studios app.
            </p>
            <p>
              If you're comparing boot camp prices across NYC, the math is straightforward: boutique studios
              charge $34 to $40 per single class, while a member training four times a week here pays a
              fraction of that per session, with a coach running every workout. That's why most people who
              finish the trial stay.
            </p>
          </div>
        </section>

        {/* ── Bottom CTA ── */}
        <section
          style={{
            borderTop: '1px solid var(--divider)',
            padding: '96px 0',
          }}
        >
          <div className="max-w-2xl mx-auto px-6 text-center">
            <h2
              className="font-display font-black uppercase mb-4"
              style={{
                fontSize: 'clamp(1.75rem, 4vw, 3rem)',
                lineHeight: '0.95',
                letterSpacing: '-0.01em',
                color: 'var(--text-primary)',
              }}
            >
              READY TO START?
            </h2>
            <p
              className="mb-10"
              style={{ color: 'var(--text-secondary)', fontSize: '1rem', lineHeight: '1.6' }}
            >
              Try us for two weeks. No long-form commitment, no pressure — just results.
            </p>
            <div className="flex flex-col sm:flex-row items-center justify-center gap-4">
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
                onMouseEnter={e => {
                  e.currentTarget.style.backgroundColor = 'var(--brand-red-hover)';
                  e.currentTarget.style.transform = 'translateY(-2px)';
                }}
                onMouseLeave={e => {
                  e.currentTarget.style.backgroundColor = 'var(--brand-red)';
                  e.currentTarget.style.transform = 'none';
                }}
              >
                Start 2-Week Trial — $49
                <ArrowRight style={{ width: '14px', height: '14px' }} />
              </a>
              <a
                href="/contact"
                className="font-semibold uppercase"
                style={{
                  color: 'var(--text-secondary)',
                  fontSize: '13px',
                  letterSpacing: '0.08em',
                  textDecoration: 'none',
                  transition: 'color 150ms ease',
                }}
                onMouseEnter={e => (e.currentTarget.style.color = 'var(--text-primary)')}
                onMouseLeave={e => (e.currentTarget.style.color = 'var(--text-secondary)')}
              >
                Questions? Contact Us →
              </a>
            </div>
          </div>
        </section>

      </div>
    </>
  );
}
