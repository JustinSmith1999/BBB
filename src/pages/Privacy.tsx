import { Link } from 'react-router-dom';
import { Shield } from 'lucide-react';
import SEOHead from '../components/SEOHead';

const sections = [
  { id: 'collection', label: 'Info We Collect' },
  { id: 'use', label: 'How We Use It' },
  { id: 'sharing', label: 'Sharing' },
  { id: 'cookies', label: 'Cookies' },
  { id: 'security', label: 'Security' },
  { id: 'retention', label: 'Data Retention' },
  { id: 'rights', label: 'Your Rights' },
  { id: 'children', label: "Children's Privacy" },
  { id: 'links', label: 'Third-Party Links' },
  { id: 'marketing', label: 'Marketing' },
  { id: 'changes', label: 'Changes' },
  { id: 'contact', label: 'Contact' },
];

function SectionCard({ number, title, children }: { number: string; title: string; children: React.ReactNode }) {
  return (
    <section id={sections.find(s => s.label === title || s.id === number.toLowerCase())?.id ?? number}>
      <div className="bg-white border border-gray-200 rounded-2xl overflow-hidden shadow-sm">
        <div className="flex items-center gap-4 bg-gray-50 px-6 py-4 border-b border-gray-200">
          <span className="text-red-500 font-black text-sm tracking-widest">{number}</span>
          <h2 className="text-lg font-black text-gray-900 tracking-tight">{title}</h2>
        </div>
        <div className="px-6 py-6 text-gray-600 text-sm leading-relaxed space-y-4">
          {children}
        </div>
      </div>
    </section>
  );
}

function BulletList({ items }: { items: string[] }) {
  return (
    <ul className="space-y-2">
      {items.map((item) => (
        <li key={item} className="flex gap-3">
          <span className="mt-1.5 w-1.5 h-1.5 bg-red-500 rounded-full flex-shrink-0" />
          {item}
        </li>
      ))}
    </ul>
  );
}

function SubHead({ children }: { children: React.ReactNode }) {
  return <h3 className="font-black text-gray-900 text-base">{children}</h3>;
}

export default function Privacy() {
  return (
    <>
    <SEOHead
      title="Privacy Policy | Better Body Bootcamp"
      description="Better Body Bootcamp privacy policy covering data collection, usage, sharing, cookies, security, and your privacy rights."
      canonical="/privacy"
      noindex={true}
    />
    <div className="min-h-screen bg-white">
      <div className="relative bg-gray-950 text-white pt-32 pb-20 overflow-hidden border-b border-gray-800">
        <div className="absolute inset-0">
          <div className="absolute inset-0 opacity-[0.03]" style={{ backgroundImage: 'repeating-linear-gradient(45deg, #fff 0, #fff 1px, transparent 0, transparent 50%)', backgroundSize: '20px 20px' }} />
          <div className="absolute bottom-0 left-0 w-full h-1 bg-gradient-to-r from-transparent via-red-600 to-transparent" />
        </div>
        <div className="relative container mx-auto px-4 text-center">
          <div className="inline-flex items-center gap-2 bg-red-600/20 border border-red-600/40 text-red-400 text-xs font-bold px-4 py-2 rounded-full mb-6 tracking-widest uppercase">
            <Shield className="w-4 h-4" />
            Legal Document
          </div>
          <h1 className="text-[clamp(2.5rem,7vw,6rem)] font-black mb-4 leading-none tracking-tight">
            Privacy <span className="text-red-500">Policy</span>
          </h1>
          <p className="text-gray-400 text-sm">Last updated: May 16, 2026</p>
        </div>
      </div>

      <div className="bg-white">
        <div className="container mx-auto px-4 py-12">
          <div className="max-w-4xl mx-auto">

            <div className="flex flex-wrap gap-2 mb-10">
              {sections.map((s) => (
                <a
                  key={s.id}
                  href={`#${s.id}`}
                  className="px-3 py-1.5 bg-gray-100 border border-gray-200 hover:bg-red-600 hover:border-red-600 hover:text-white text-gray-600 rounded-lg text-xs font-bold transition-all tracking-wide"
                >
                  {s.label}
                </a>
              ))}
            </div>

            <div className="mb-8 p-5 bg-red-50 border border-red-200 rounded-xl">
              <p className="text-red-700 text-sm leading-relaxed">
                Better Body Bootcamp LLC is committed to protecting your personal information. This Privacy Policy explains how we collect, use, disclose, and safeguard your data when you visit our website or use our services. Please read this policy carefully.
              </p>
            </div>

            <div className="space-y-6">

              <section id="collection">
                <div className="bg-white border border-gray-200 rounded-2xl overflow-hidden shadow-sm">
                  <div className="flex items-center gap-4 bg-gray-50 px-6 py-4 border-b border-gray-200">
                    <span className="text-red-500 font-black text-sm tracking-widest">01</span>
                    <h2 className="text-lg font-black text-gray-900 tracking-tight">Information We Collect</h2>
                  </div>
                  <div className="px-6 py-6 space-y-6 text-gray-600 text-sm leading-relaxed">
                    <div className="space-y-3">
                      <SubHead>Information You Provide Directly</SubHead>
                      <p>When you register, sign up for a trial, book a class, or contact us, we may collect:</p>
                      <BulletList items={[
                        'Full name and date of birth',
                        'Email address and phone number',
                        'Home address',
                        'Payment and billing information (processed securely via Stripe)',
                        'Health and fitness information you voluntarily provide',
                        'Emergency contact information',
                        'Signed waivers and liability releases',
                        'Communications you send to our team',
                      ]} />
                    </div>
                    <div className="space-y-3">
                      <SubHead>Information Collected Automatically</SubHead>
                      <p>When you visit our website, we may automatically collect:</p>
                      <BulletList items={[
                        'IP address and general geographic location',
                        'Browser type, version, and operating system',
                        'Pages viewed, time spent, and navigation paths',
                        'Referring website or search query',
                        'Device type and screen resolution',
                        'Cookie and tracking pixel data',
                      ]} />
                    </div>
                    <div className="space-y-2">
                      <SubHead>Information from Third Parties</SubHead>
                      <p>We may receive information about you from Mindbody (class booking), Stripe (payment processing), and analytics platforms. Information received from these services is governed by their respective privacy policies.</p>
                    </div>
                  </div>
                </div>
              </section>

              <SectionCard number="02" title="How We Use Your Information">
                <p>We use the information we collect to:</p>
                <BulletList items={[
                  'Process membership enrollments, payments, and class bookings',
                  'Communicate with you about your membership, classes, and promotions',
                  'Send administrative notices, updates, and service-related messages',
                  'Personalize your experience and improve our services',
                  'Respond to your inquiries, questions, and support requests',
                  'Maintain the safety of our facilities and members',
                  'Comply with legal obligations and enforce our Terms of Service',
                  'Analyze usage trends to improve our website and programs',
                  'Send marketing and promotional communications (with your consent)',
                ]} />
              </SectionCard>

              <section id="sharing">
                <div className="bg-white border border-gray-200 rounded-2xl overflow-hidden shadow-sm">
                  <div className="flex items-center gap-4 bg-gray-50 px-6 py-4 border-b border-gray-200">
                    <span className="text-red-500 font-black text-sm tracking-widest">03</span>
                    <h2 className="text-lg font-black text-gray-900 tracking-tight">How We Share Your Information</h2>
                  </div>
                  <div className="px-6 py-6 space-y-5 text-gray-600 text-sm leading-relaxed">
                    <p>We do not sell or trade your personal information. We share data with the following categories of trusted service providers, each of whom is contractually required to keep your information confidential and use it only to deliver services on our behalf:</p>
                    <div className="space-y-2">
                      <SubHead>Payments &amp; Membership</SubHead>
                      <p><strong className="text-gray-900">Stripe</strong> (payment processing), <strong className="text-gray-900">MindBody</strong> (class scheduling, membership management, attendance).</p>
                    </div>
                    <div className="space-y-2">
                      <SubHead>Communications</SubHead>
                      <p><strong className="text-gray-900">Resend</strong> (transactional and marketing email), <strong className="text-gray-900">Twilio</strong> (SMS notifications and marketing), <strong className="text-gray-900">GoHighLevel</strong> (CRM and conversation history).</p>
                    </div>
                    <div className="space-y-2">
                      <SubHead>Hosting &amp; Infrastructure</SubHead>
                      <p><strong className="text-gray-900">Supabase</strong> (database and authentication), <strong className="text-gray-900">Netlify</strong> (web hosting and content delivery).</p>
                    </div>
                    <div className="space-y-2">
                      <SubHead>Advertising &amp; Analytics</SubHead>
                      <p><strong className="text-gray-900">Meta Platforms, Inc.</strong> (Facebook and Instagram advertising via Meta Pixel and the Meta Conversions API). When you visit our trial signup pages or complete an action like submitting a form or starting checkout, we send Meta event information (such as PageView, Lead, and InitiateCheckout events) and, where you have provided it, hashed contact data (email, phone, name) so Meta can measure the performance of our advertising and show our ads to relevant audiences. This data is hashed before transmission using industry-standard SHA-256. See section 04 for more detail on the Meta Pixel and Conversions API and how to opt out.</p>
                    </div>
                    <div className="space-y-2">
                      <SubHead>Legal Requirements</SubHead>
                      <p>We may disclose your information if required by law, court order, or government regulation, or if we believe disclosure is necessary to protect rights, property, or safety.</p>
                    </div>
                    <div className="space-y-2">
                      <SubHead>Business Transfers</SubHead>
                      <p>In the event of a merger, acquisition, or sale of assets, your personal information may be transferred. We will notify you of any such change via email or a notice on our website.</p>
                    </div>
                  </div>
                </div>
              </section>

              <section id="cookies">
                <div className="bg-white border border-gray-200 rounded-2xl overflow-hidden shadow-sm">
                  <div className="flex items-center gap-4 bg-gray-50 px-6 py-4 border-b border-gray-200">
                    <span className="text-red-500 font-black text-sm tracking-widest">04</span>
                    <h2 className="text-lg font-black text-gray-900 tracking-tight">Cookies, Tracking Technologies &amp; the Meta Pixel</h2>
                  </div>
                  <div className="px-6 py-6 space-y-5 text-gray-600 text-sm leading-relaxed">
                    <p>Our website uses cookies and similar tracking technologies (including web beacons, pixels, and local storage) to enhance your experience, recognize you on return visits, remember your preferences, analyze traffic, and measure the performance of our advertising. We use the following categories:</p>
                    <ul className="space-y-3">
                      {[
                        { name: 'Essential cookies', desc: 'Necessary for the website to function properly (session, security, load balancing). Cannot be disabled without breaking core site functionality.' },
                        { name: 'Analytics cookies', desc: 'Help us understand how visitors use our site so we can improve it.' },
                        { name: 'Advertising cookies', desc: 'Set by Meta (Facebook and Instagram) and other advertising partners so we can measure conversions from our ads and show ads to relevant audiences.' },
                      ].map((item) => (
                        <li key={item.name} className="flex gap-3">
                          <span className="mt-1.5 w-1.5 h-1.5 bg-red-500 rounded-full flex-shrink-0" />
                          <span><strong className="text-gray-900">{item.name}:</strong> {item.desc}</span>
                        </li>
                      ))}
                    </ul>

                    <div className="space-y-3 pt-2">
                      <SubHead>Meta Pixel and Meta Conversions API</SubHead>
                      <p>
                        Pages on our website — particularly the trial signup pages at <code className="bg-gray-100 px-1.5 py-0.5 rounded text-xs">betterbodybootcamp.com/trial/*</code> — load the Meta Pixel from Meta Platforms, Inc. The Pixel allows us to measure the effectiveness of our advertising on Facebook and Instagram and to show our ads to audiences that are likely to be interested in our services.
                      </p>
                      <p>
                        Each of our four studio locations operates an independent Meta Pixel, and the Pixel loaded on a given page is scoped to that specific studio's advertising account. When the Pixel fires, the following events may be sent to Meta:
                      </p>
                      <BulletList items={[
                        'PageView — when a page on our site loads.',
                        'Lead — when you submit a trial signup form (sent before checkout so that abandoned signups can still be measured).',
                        'InitiateCheckout — when you proceed from our form to the Stripe checkout page.',
                        'Purchase — when a paid trial is completed (sent server-side via the Meta Conversions API).',
                      ]} />
                      <p>
                        Where you have provided it, we may also send Meta hashed (SHA-256) personal identifiers such as your email address, phone number, name, city, and zip code so Meta can match the event to your account for measurement and ad personalization. We never send Meta your payment card information, government identifiers, or precise health information.
                      </p>
                      <p>
                        We also use the <strong className="text-gray-900">Meta Conversions API</strong> to send conversion events to Meta server-to-server. This is in addition to (and in some cases instead of) browser-based Pixel events so that conversions can still be measured if your browser blocks third-party tracking.
                      </p>
                      <p>
                        For more information about how Meta uses this data, see Meta's{' '}
                        <a href="https://www.facebook.com/privacy/policy/" target="_blank" rel="noopener noreferrer" className="text-red-600 hover:text-red-700 underline">Privacy Policy</a>
                        {' '}and the{' '}
                        <a href="https://www.facebook.com/business/help/471978536642445" target="_blank" rel="noopener noreferrer" className="text-red-600 hover:text-red-700 underline">Meta Business Tools Terms</a>.
                      </p>
                    </div>

                    <div className="space-y-3 pt-2">
                      <SubHead>How to Opt Out of Ad Tracking</SubHead>
                      <BulletList items={[
                        'Manage your Meta ad preferences and request restriction of data use directly at facebook.com/adpreferences and instagram.com/accounts/privacy_and_security.',
                        'Use your browser settings to block third-party cookies or to enable Do Not Track / Global Privacy Control signals (we honor GPC where required by law).',
                        'Install a browser tracking-prevention tool (e.g., Privacy Badger, uBlock Origin) or use a browser with built-in tracking protection.',
                        'On iOS 14.5+ and Android 13+, decline App Tracking Transparency / advertising ID permission when prompted by the Facebook or Instagram apps.',
                        'Email privacy@betterbodybootcamp.com to request that we suppress your contact data from being sent to advertising partners.',
                      ]} />
                      <p>Disabling cookies or opting out of ad tracking will not prevent you from using our website, but certain personalization features and ad-relevance may be reduced.</p>
                    </div>
                  </div>
                </div>
              </section>

              <SectionCard number="05" title="Data Security">
                <p>We implement industry-standard security measures including SSL/TLS encryption, secure server infrastructure, restricted employee access, and regular security audits.</p>
                <p>While we take reasonable precautions, no method of internet transmission is 100% secure. If you believe your data has been compromised, please contact us immediately.</p>
              </SectionCard>

              <SectionCard number="06" title="Data Retention">
                <p>We retain your personal information for as long as necessary to fulfill the purposes in this Privacy Policy, maintain your account, comply with legal obligations, resolve disputes, and enforce our agreements.</p>
                <p>Upon termination of your membership, certain information will be retained as required by applicable law. You may request deletion of your data subject to legal retention requirements.</p>
              </SectionCard>

              <section id="rights">
                <div className="bg-white border border-gray-200 rounded-2xl overflow-hidden shadow-sm">
                  <div className="flex items-center gap-4 bg-gray-50 px-6 py-4 border-b border-gray-200">
                    <span className="text-red-500 font-black text-sm tracking-widest">07</span>
                    <h2 className="text-lg font-black text-gray-900 tracking-tight">Your Privacy Rights</h2>
                  </div>
                  <div className="px-6 py-6 space-y-4 text-gray-600 text-sm leading-relaxed">
                    <p>Depending on your location, you may have the following rights:</p>
                    <ul className="space-y-2">
                      {[
                        { name: 'Access', desc: 'Request a copy of the personal information we hold about you.' },
                        { name: 'Correction', desc: 'Request correction of inaccurate or incomplete information.' },
                        { name: 'Deletion', desc: 'Request deletion of your personal information, subject to legal requirements.' },
                        { name: 'Portability', desc: 'Request your data in a structured, machine-readable format.' },
                        { name: 'Opt-out', desc: 'Unsubscribe from marketing communications at any time.' },
                        { name: 'Restriction', desc: 'Request restriction of certain processing activities.' },
                      ].map((item) => (
                        <li key={item.name} className="flex gap-3">
                          <span className="mt-1.5 w-1.5 h-1.5 bg-red-500 rounded-full flex-shrink-0" />
                          <span><strong className="text-gray-900">{item.name}:</strong> {item.desc}</span>
                        </li>
                      ))}
                    </ul>
                    <p>
                      To exercise these rights, contact us at{' '}
                      <a href="mailto:privacy@betterbodybootcamp.com" className="text-red-600 hover:text-red-700 underline">
                        privacy@betterbodybootcamp.com
                      </a>. We will respond within 30 days.
                    </p>
                  </div>
                </div>
              </section>

              <SectionCard number="08" title="Children's Privacy">
                <p>Our services are intended for individuals 18 years of age or older. We do not knowingly collect personal information from children under 13. If we become aware of such collection without parental consent, we will take steps to delete that information. If you believe we have inadvertently collected data from a minor, please contact us immediately.</p>
              </SectionCard>

              <SectionCard number="09" title="Third-Party Links">
                <p>Our website may contain links to third-party websites including Mindbody and our social media pages. We are not responsible for the privacy practices of external sites. We encourage you to review their privacy policies before providing any personal information.</p>
              </SectionCard>

              <SectionCard number="10" title="Marketing Communications">
                <p>With your consent, we may send promotional emails about new classes, membership offers, events, and news. You may opt out at any time by clicking "unsubscribe" in any email or by contacting us directly. You will continue to receive service-related communications necessary to manage your membership even after opting out of marketing.</p>
              </SectionCard>

              <SectionCard number="11" title="Changes to This Policy">
                <p>We may update this Privacy Policy periodically to reflect changes in our practices, technology, or legal requirements. We will notify you of significant changes by posting a notice on our website and, where required by law, obtaining your consent. Your continued use of our services after any changes constitutes acceptance of the updated policy.</p>
              </SectionCard>

              <section id="contact">
                <div className="bg-white border border-red-200 rounded-2xl overflow-hidden shadow-sm">
                  <div className="flex items-center gap-4 bg-red-50 px-6 py-4 border-b border-red-200">
                    <span className="text-red-500 font-black text-sm tracking-widest">12</span>
                    <h2 className="text-lg font-black text-gray-900 tracking-tight">Contact Us</h2>
                  </div>
                  <div className="px-6 py-6 text-gray-600 text-sm leading-relaxed space-y-4 text-center">
                    <p>For questions, concerns, or data requests related to your privacy:</p>
                    <div className="bg-gray-50 border border-gray-200 p-5 rounded-xl space-y-2 inline-block w-full">
                      <p className="font-black text-gray-900">Better Body Bootcamp LLC — Privacy Team</p>
                      <p className="text-gray-500">New York, NY</p>
                      <p className="text-gray-600">
                        Privacy:{' '}
                        <a href="mailto:privacy@betterbodybootcamp.com" className="text-red-600 hover:text-red-700 underline">
                          privacy@betterbodybootcamp.com
                        </a>
                      </p>
                      <p className="text-gray-600">
                        General:{' '}
                        <a href="mailto:info@betterbodybootcamp.com" className="text-red-600 hover:text-red-700 underline">
                          info@betterbodybootcamp.com
                        </a>
                      </p>
                    </div>
                  </div>
                </div>
              </section>

            </div>

            <div className="mt-12 pt-8 border-t border-gray-200 flex flex-col sm:flex-row items-center justify-between gap-4">
              <p className="text-gray-400 text-xs">Questions about how we handle your data?</p>
              <div className="flex gap-3">
                <Link to="/contact" className="bg-red-600 hover:bg-red-700 text-white px-6 py-2.5 rounded-lg font-bold text-sm transition-all">
                  Contact Us
                </Link>
                <Link to="/terms" className="border border-gray-300 hover:border-gray-500 text-gray-500 hover:text-gray-900 px-6 py-2.5 rounded-lg font-bold text-sm transition-all">
                  Terms of Service
                </Link>
              </div>
            </div>

          </div>
        </div>
      </div>
    </div>
    </>
  );
}
