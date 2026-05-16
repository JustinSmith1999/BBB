export default function BrandPillars() {
  const pillars = [
    {
      eyebrow: 'TRAIN',
      title: 'STRENGTH',
      description: 'Build real, functional strength that translates to every area of your life. Our high-intensity workouts push you beyond your limits.',
    },
    {
      eyebrow: 'COMMUNITY',
      title: 'COMMUNITY',
      description: 'Train alongside motivated individuals who push you to be better. Our community is your support system, your competition, your family.',
    },
    {
      eyebrow: 'RESULTS',
      title: 'RESULTS',
      description: 'See measurable progress in strength, endurance, and physique. Our proven methodology delivers transformation you can see and feel.',
    },
  ];

  return (
    <section
      className="relative overflow-clip"
      style={{ backgroundColor: 'var(--bg-primary)', padding: '120px 0 120px' }}
    >
      <div className="max-w-content mx-auto px-6">
        <div className="grid grid-cols-1 md:grid-cols-3 gap-12 lg:gap-16">
          {pillars.map((pillar, index) => (
            <div
              key={index}
              className="group"
              style={{ borderTop: '1px solid var(--divider)', paddingTop: '32px' }}
            >
              <p className="eyebrow mb-4">{pillar.eyebrow}</p>
              <h2
                className="font-display font-black uppercase mb-4 transition-colors duration-200"
                style={{
                  fontSize: 'clamp(2rem, 4vw, 3rem)',
                  lineHeight: '0.95',
                  letterSpacing: '-0.01em',
                  color: 'var(--text-primary)',
                }}
              >
                {pillar.title}
              </h2>
              <p
                className="text-base leading-relaxed"
                style={{ color: 'var(--text-secondary)', maxWidth: '36ch', lineHeight: '1.65' }}
              >
                {pillar.description}
              </p>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}
