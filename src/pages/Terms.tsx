import { Link } from 'react-router-dom';
import { FileText } from 'lucide-react';
import SEOHead from '../components/SEOHead';

const sections = [
  { id: 'about', label: 'About Us' },
  { id: 'membership', label: 'Membership' },
  { id: 'cancellation', label: 'Cancellation' },
  { id: 'health', label: 'Health & Safety' },
  { id: 'conduct', label: 'Code of Conduct' },
  { id: 'ip', label: 'Intellectual Property' },
  { id: 'media', label: 'Photography & Media' },
  { id: 'liability', label: 'Limitation of Liability' },
  { id: 'governing', label: 'Governing Law' },
  { id: 'changes', label: 'Changes' },
  { id: 'contact', label: 'Contact' },
];

function SubHead({ children }: { children: React.ReactNode }) {
  return <h3 className="font-black text-gray-900 text-base">{children}</h3>;
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

export default function Terms() {
  return (
    <>
    <SEOHead
      title="Terms of Service | Better Body Bootcamp"
      description="Better Body Bootcamp terms of service covering membership agreements, cancellation policy, health waivers, code of conduct, and governing law."
      canonical="/terms"
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
            <FileText className="w-4 h-4" />
            Legal Document
          </div>
          <h1 className="text-[clamp(2rem,4.5vw,4rem)] font-black mb-4 leading-none tracking-tight">
            Terms of <span className="text-red-500">Service</span>
          </h1>
          <p className="text-gray-400 text-sm">Last updated: April 1, 2025</p>
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
                Please read these Terms of Service carefully before using the Better Body Bootcamp website or enrolling in any membership, class, or program. By accessing our website or participating in our services, you agree to be bound by these terms.
              </p>
            </div>

            <div className="space-y-6">

              <section id="about">
                <div className="bg-white border border-gray-200 rounded-2xl overflow-hidden shadow-sm">
                  <div className="flex items-center gap-4 bg-gray-50 px-6 py-4 border-b border-gray-200">
                    <span className="text-red-500 font-black text-sm tracking-widest">01</span>
                    <h2 className="text-lg font-black text-gray-900 tracking-tight">About Better Body Bootcamp</h2>
                  </div>
                  <div className="px-6 py-6 space-y-4 text-gray-600 text-sm leading-relaxed">
                    <p>Better Body Bootcamp LLC ("Better Body Bootcamp," "we," "our," or "us") operates group fitness facilities throughout New York City, including locations in Astoria, Bayside, Fresh Meadows, and Williamsburg. We offer group training classes, personal training, nutrition guidance, and related fitness services.</p>
                    <p>These Terms of Service govern your use of our website at betterbodybootcamp.com and all associated subdomains, as well as your participation in any Better Body Bootcamp programs, classes, or services.</p>
                  </div>
                </div>
              </section>

              <section id="membership">
                <div className="bg-white border border-gray-200 rounded-2xl overflow-hidden shadow-sm">
                  <div className="flex items-center gap-4 bg-gray-50 px-6 py-4 border-b border-gray-200">
                    <span className="text-red-500 font-black text-sm tracking-widest">02</span>
                    <h2 className="text-lg font-black text-gray-900 tracking-tight">Membership Agreement</h2>
                  </div>
                  <div className="px-6 py-6 space-y-5 text-gray-600 text-sm leading-relaxed">
                    <div className="space-y-2">
                      <SubHead>Enrollment</SubHead>
                      <p>By enrolling in a Better Body Bootcamp membership, you agree to the specific terms presented at the time of enrollment, including the applicable membership rate, billing cycle, and duration. All memberships are personal and non-transferable.</p>
                    </div>
                    <div className="space-y-2">
                      <SubHead>Billing and Payment</SubHead>
                      <p>Membership fees are charged on a recurring basis (weekly, bi-weekly, or monthly, depending on the plan selected). By providing your payment information, you authorize Better Body Bootcamp to charge the applicable fees to your payment method on the agreed billing date. If a payment fails, we may attempt to recharge within 3–5 business days. Continued failure to pay may result in suspension or termination of your membership.</p>
                    </div>
                    <div className="space-y-2">
                      <SubHead>Trial Offers</SubHead>
                      <p>Trial offers are available to new members only and are limited to one per person. Trial memberships are non-refundable and cannot be combined with other promotions. After the trial period, your membership will automatically convert to the selected plan unless you cancel prior to expiration.</p>
                    </div>
                    <div className="space-y-2">
                      <SubHead>Price Changes</SubHead>
                      <p>Better Body Bootcamp reserves the right to change membership pricing with at least 30 days' written notice via email. Continued use of services after the price change takes effect constitutes acceptance of the new pricing.</p>
                    </div>
                  </div>
                </div>
              </section>

              <section id="cancellation">
                <div className="bg-white border border-gray-200 rounded-2xl overflow-hidden shadow-sm">
                  <div className="flex items-center gap-4 bg-gray-50 px-6 py-4 border-b border-gray-200">
                    <span className="text-red-500 font-black text-sm tracking-widest">03</span>
                    <h2 className="text-lg font-black text-gray-900 tracking-tight">Cancellation Policy</h2>
                  </div>
                  <div className="px-6 py-6 space-y-5 text-gray-600 text-sm leading-relaxed">
                    <div className="space-y-2">
                      <SubHead>Membership Cancellation</SubHead>
                      <p>Members may cancel their membership by providing written notice to their home location at least 30 days before the next billing date. Cancellations must be submitted in writing via email or in person. Verbal cancellations are not accepted. No refunds will be issued for any unused portion of a billing period.</p>
                    </div>
                    <div className="space-y-2">
                      <SubHead>Class Cancellations</SubHead>
                      <p>Members must cancel scheduled classes through the Better Body Studios app only. Cancellations by phone or any other method are not accepted. Late cancellations or no-shows may be subject to a late cancel fee as outlined in your membership agreement. Repeat late cancellations may result in additional fees or restrictions on future bookings.</p>
                    </div>
                    <div className="space-y-2">
                      <SubHead>Membership Freeze</SubHead>
                      <p>Members with a 12-month membership may freeze their membership one time for up to 30 days. Membership billing resumes automatically at the end of the freeze period.</p>
                    </div>
                  </div>
                </div>
              </section>

              <section id="health">
                <div className="bg-white border border-red-200 rounded-2xl overflow-hidden shadow-sm">
                  <div className="flex items-center gap-4 bg-red-50 px-6 py-4 border-b border-red-200">
                    <span className="text-red-500 font-black text-sm tracking-widest">04</span>
                    <h2 className="text-lg font-black text-gray-900 tracking-tight">Health and Safety Waiver</h2>
                  </div>
                  <div className="px-6 py-6 space-y-5 text-gray-600 text-sm leading-relaxed">
                    <div className="space-y-2">
                      <SubHead>Medical Clearance</SubHead>
                      <p>You represent that you are in good physical health and have no medical condition that would prevent you from participating in physical exercise. You are strongly encouraged to consult with a licensed physician before beginning any new exercise program, particularly if you have any pre-existing conditions, injuries, or concerns.</p>
                    </div>
                    <div className="space-y-2">
                      <SubHead>Assumption of Risk</SubHead>
                      <p>By participating in Better Body Bootcamp classes, programs, or activities, you acknowledge that physical exercise involves inherent risks including, but not limited to, muscle strain, ligament tears, fractures, cardiovascular events, and other injuries. You voluntarily assume all risks associated with your participation.</p>
                    </div>
                    <div className="space-y-2">
                      <SubHead>Release of Liability</SubHead>
                      <p>To the fullest extent permitted by law, you release and hold harmless Better Body Bootcamp LLC, its owners, officers, employees, contractors, and agents from any and all claims, damages, losses, or liabilities arising from your participation in our programs or use of our facilities, except in cases of gross negligence or intentional misconduct.</p>
                    </div>
                  </div>
                </div>
              </section>

              <section id="conduct">
                <div className="bg-white border border-gray-200 rounded-2xl overflow-hidden shadow-sm">
                  <div className="flex items-center gap-4 bg-gray-50 px-6 py-4 border-b border-gray-200">
                    <span className="text-red-500 font-black text-sm tracking-widest">05</span>
                    <h2 className="text-lg font-black text-gray-900 tracking-tight">Code of Conduct</h2>
                  </div>
                  <div className="px-6 py-6 space-y-4 text-gray-600 text-sm leading-relaxed">
                    <p>Members are expected to:</p>
                    <BulletList items={[
                      'Treat all staff, trainers, and fellow members with respect and courtesy',
                      'Arrive on time for scheduled classes and check in at the front desk',
                      'Wear appropriate athletic attire and clean footwear at all times',
                      'Follow all instructions given by trainers and staff',
                      'Return all equipment to its designated storage location after use',
                      'Refrain from using mobile phones during class sessions',
                      'Report any equipment damage or safety concerns to staff immediately',
                      'Maintain personal hygiene standards out of respect for fellow members',
                    ]} />
                    <p>Better Body Bootcamp reserves the right to terminate any membership, without refund, for conduct that is disruptive, abusive, threatening, or otherwise in violation of these standards.</p>
                  </div>
                </div>
              </section>

              <section id="ip">
                <div className="bg-white border border-gray-200 rounded-2xl overflow-hidden shadow-sm">
                  <div className="flex items-center gap-4 bg-gray-50 px-6 py-4 border-b border-gray-200">
                    <span className="text-red-500 font-black text-sm tracking-widest">06</span>
                    <h2 className="text-lg font-black text-gray-900 tracking-tight">Intellectual Property</h2>
                  </div>
                  <div className="px-6 py-6 space-y-4 text-gray-600 text-sm leading-relaxed">
                    <p>All content on the Better Body Bootcamp website, including text, images, logos, videos, graphics, and workout programming, is the exclusive property of Better Body Bootcamp LLC and is protected by applicable copyright, trademark, and intellectual property laws.</p>
                    <p>You may not reproduce, distribute, modify, create derivative works from, publicly display, or commercially exploit any content without express written permission from Better Body Bootcamp LLC.</p>
                  </div>
                </div>
              </section>

              <section id="media">
                <div className="bg-white border border-gray-200 rounded-2xl overflow-hidden shadow-sm">
                  <div className="flex items-center gap-4 bg-gray-50 px-6 py-4 border-b border-gray-200">
                    <span className="text-red-500 font-black text-sm tracking-widest">07</span>
                    <h2 className="text-lg font-black text-gray-900 tracking-tight">Photography and Media</h2>
                  </div>
                  <div className="px-6 py-6 text-gray-600 text-sm leading-relaxed">
                    <p>By participating in Better Body Bootcamp classes and events, you grant Better Body Bootcamp LLC a non-exclusive, royalty-free license to photograph, record, and use your likeness in marketing materials, social media, and promotional content. If you do not consent, you must notify staff in writing prior to your first session.</p>
                  </div>
                </div>
              </section>

              <section id="liability">
                <div className="bg-white border border-gray-200 rounded-2xl overflow-hidden shadow-sm">
                  <div className="flex items-center gap-4 bg-gray-50 px-6 py-4 border-b border-gray-200">
                    <span className="text-red-500 font-black text-sm tracking-widest">08</span>
                    <h2 className="text-lg font-black text-gray-900 tracking-tight">Limitation of Liability</h2>
                  </div>
                  <div className="px-6 py-6 space-y-4 text-gray-600 text-sm leading-relaxed">
                    <p>To the maximum extent permitted by applicable law, Better Body Bootcamp LLC shall not be liable for any indirect, incidental, special, consequential, or punitive damages, including but not limited to loss of data, loss of revenue, personal injury, or property damage arising from your use of our services or facilities.</p>
                    <p>Our total liability to you for any claims arising under these Terms shall not exceed the total amount you paid to Better Body Bootcamp in the three months preceding the claim.</p>
                  </div>
                </div>
              </section>

              <section id="governing">
                <div className="bg-white border border-gray-200 rounded-2xl overflow-hidden shadow-sm">
                  <div className="flex items-center gap-4 bg-gray-50 px-6 py-4 border-b border-gray-200">
                    <span className="text-red-500 font-black text-sm tracking-widest">09</span>
                    <h2 className="text-lg font-black text-gray-900 tracking-tight">Governing Law and Dispute Resolution</h2>
                  </div>
                  <div className="px-6 py-6 space-y-4 text-gray-600 text-sm leading-relaxed">
                    <p>These Terms of Service are governed by the laws of the State of New York, without regard to conflict of law principles. Any disputes arising from these terms or your use of our services shall be resolved through binding arbitration in New York County, New York, except that either party may seek injunctive or other equitable relief in any court of competent jurisdiction.</p>
                    <p>You waive any right to participate in a class action lawsuit or class-wide arbitration against Better Body Bootcamp LLC.</p>
                  </div>
                </div>
              </section>

              <section id="changes">
                <div className="bg-white border border-gray-200 rounded-2xl overflow-hidden shadow-sm">
                  <div className="flex items-center gap-4 bg-gray-50 px-6 py-4 border-b border-gray-200">
                    <span className="text-red-500 font-black text-sm tracking-widest">10</span>
                    <h2 className="text-lg font-black text-gray-900 tracking-tight">Changes to These Terms</h2>
                  </div>
                  <div className="px-6 py-6 text-gray-600 text-sm leading-relaxed">
                    <p>Better Body Bootcamp reserves the right to update or modify these Terms at any time. We will notify members of material changes via email or by posting a notice on our website. Your continued use of our services following notification constitutes acceptance of the revised terms.</p>
                  </div>
                </div>
              </section>

              <section id="contact">
                <div className="bg-white border border-red-200 rounded-2xl overflow-hidden shadow-sm">
                  <div className="flex items-center gap-4 bg-red-50 px-6 py-4 border-b border-red-200">
                    <span className="text-red-500 font-black text-sm tracking-widest">11</span>
                    <h2 className="text-lg font-black text-gray-900 tracking-tight">Contact Us</h2>
                  </div>
                  <div className="px-6 py-6 text-gray-600 text-sm leading-relaxed space-y-4 text-center">
                    <p>If you have any questions about these Terms of Service, please contact us:</p>
                    <div className="bg-gray-50 border border-gray-200 p-5 rounded-xl space-y-2 inline-block w-full">
                      <p className="font-black text-gray-900">Better Body Bootcamp LLC</p>
                      <p className="text-gray-500">New York, NY</p>
                      <p className="text-gray-600">
                        Email:{' '}
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
              <p className="text-gray-400 text-xs">Have questions about our terms?</p>
              <div className="flex gap-3">
                <Link to="/contact" className="bg-red-600 hover:bg-red-700 text-white px-6 py-2.5 rounded-lg font-bold text-sm transition-all">
                  Contact Us
                </Link>
                <Link to="/privacy" className="border border-gray-300 hover:border-gray-500 text-gray-500 hover:text-gray-900 px-6 py-2.5 rounded-lg font-bold text-sm transition-all">
                  Privacy Policy
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
