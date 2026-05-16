import { Link } from 'react-router-dom';
import { FileText, Shield, HelpCircle, ChevronRight, Scale } from 'lucide-react';

export default function Legal() {
  const documents = [
    {
      icon: HelpCircle,
      title: 'FAQ',
      description:
        'Answers to the most common questions about our classes, memberships, locations, and what to expect when you join Better Body Bootcamp.',
      link: '/faq',
      highlights: ['Getting started', 'Membership options', 'Class schedules', 'Facility info'],
    },
    {
      icon: FileText,
      title: 'Terms of Service',
      description:
        'Our membership agreement, class policies, cancellation terms, code of conduct, and the legal framework governing your use of Better Body Bootcamp services.',
      link: '/terms',
      highlights: ['Membership & billing', 'Cancellation policy', 'Code of conduct', 'Liability'],
    },
    {
      icon: Shield,
      title: 'Privacy Policy',
      description:
        'How we collect, use, protect, and share your personal information — and how to exercise your privacy rights as a member or visitor.',
      link: '/privacy',
      highlights: ['Data we collect', 'How we use it', 'Your rights', 'Data security'],
    },
  ];

  return (
    <div className="min-h-screen bg-white">
      <div className="relative bg-gray-950 text-white pt-32 pb-24 overflow-hidden border-b border-gray-800">
        <div className="absolute inset-0">
          <div className="absolute inset-0 opacity-[0.03]" style={{ backgroundImage: 'repeating-linear-gradient(45deg, #fff 0, #fff 1px, transparent 0, transparent 50%)', backgroundSize: '20px 20px' }} />
          <div className="absolute bottom-0 left-0 w-full h-1 bg-gradient-to-r from-transparent via-red-600 to-transparent" />
        </div>
        <div className="relative container mx-auto px-4 text-center">
          <div className="inline-flex items-center gap-2 bg-red-600/20 border border-red-600/40 text-red-400 text-xs font-bold px-4 py-2 rounded-full mb-6 tracking-widest uppercase">
            <Scale className="w-4 h-4" />
            Legal & Policies
          </div>
          <h1 className="text-[clamp(2.5rem,7vw,6rem)] font-black mb-5 leading-none tracking-tight">
            Legal <span className="text-red-500">Information</span>
          </h1>
          <p className="text-lg text-gray-400 max-w-2xl mx-auto leading-relaxed">
            Transparency is important to us. Here you'll find all legal documents, policies, and resources that govern your relationship with Better Body Bootcamp.
          </p>
        </div>
      </div>

      <div className="container mx-auto px-4 py-16">
        <div className="max-w-5xl mx-auto space-y-16">

          <div className="grid gap-6 md:grid-cols-3">
            {documents.map((doc) => {
              const Icon = doc.icon;
              return (
                <Link
                  key={doc.title}
                  to={doc.link}
                  className="group relative bg-white border border-gray-200 hover:border-red-400 rounded-2xl p-8 transition-all duration-300 flex flex-col overflow-hidden shadow-sm hover:shadow-md"
                >
                  <div className="absolute top-0 right-0 w-32 h-32 bg-red-600/5 rounded-bl-full opacity-0 group-hover:opacity-100 transition-opacity duration-300" />
                  <div className="relative flex flex-col flex-1">
                    <div className="w-12 h-12 bg-gray-100 group-hover:bg-red-600 rounded-xl flex items-center justify-center mb-5 transition-colors duration-300">
                      <Icon className="w-6 h-6 text-gray-500 group-hover:text-white transition-colors duration-300" />
                    </div>
                    <h2 className="text-xl font-black text-gray-900 mb-3 tracking-tight">
                      {doc.title}
                    </h2>
                    <p className="text-gray-500 text-sm leading-relaxed mb-6 flex-1">
                      {doc.description}
                    </p>
                    <ul className="space-y-1.5 mb-6">
                      {doc.highlights.map((item) => (
                        <li key={item} className="flex items-center gap-2 text-sm text-gray-400">
                          <span className="w-1.5 h-1.5 bg-red-500 rounded-full flex-shrink-0" />
                          {item}
                        </li>
                      ))}
                    </ul>
                    <div className="flex items-center gap-1.5 text-red-500 font-bold text-sm group-hover:gap-3 transition-all">
                      Read document
                      <ChevronRight className="w-4 h-4" />
                    </div>
                  </div>
                </Link>
              );
            })}
          </div>

          <div className="grid md:grid-cols-2 gap-6">
            <div className="bg-white border border-gray-200 rounded-2xl overflow-hidden shadow-sm">
              <div className="bg-gray-50 px-6 py-4 border-b border-gray-200">
                <h2 className="text-lg font-black text-gray-900 tracking-tight">Liability Waiver Summary</h2>
              </div>
              <div className="px-6 py-6 space-y-4">
                <p className="text-gray-500 text-sm leading-relaxed">
                  All members and guests must acknowledge our liability waiver prior to their first class. By enrolling, you confirm you have read and agreed to the following:
                </p>
                <ul className="space-y-4">
                  {[
                    { label: 'Assumption of Risk', desc: 'Physical exercise carries inherent risks you voluntarily accept.' },
                    { label: 'Medical Fitness', desc: 'You represent you are in adequate health to participate in vigorous exercise.' },
                    { label: 'Release of Claims', desc: 'You release Better Body Bootcamp from liability for injury except in cases of gross negligence.' },
                    { label: 'Emergency Authorization', desc: 'Staff may seek medical assistance on your behalf in an emergency.' },
                  ].map((item) => (
                    <li key={item.label} className="flex gap-3">
                      <span className="mt-1 w-1.5 h-1.5 bg-red-500 rounded-full flex-shrink-0" />
                      <div>
                        <span className="font-black text-gray-900 text-sm">{item.label}: </span>
                        <span className="text-gray-500 text-sm">{item.desc}</span>
                      </div>
                    </li>
                  ))}
                </ul>
                <p className="text-xs text-gray-400 italic border-t border-gray-200 pt-4">
                  A full waiver must be signed before your first class. Digital signatures are accepted via the Mindbody booking system.
                </p>
              </div>
            </div>

            <div className="bg-white border border-gray-200 rounded-2xl overflow-hidden shadow-sm">
              <div className="bg-gray-50 px-6 py-4 border-b border-gray-200">
                <h2 className="text-lg font-black text-gray-900 tracking-tight">New York State Compliance</h2>
              </div>
              <div className="px-6 py-6 space-y-4">
                <p className="text-gray-500 text-sm leading-relaxed">
                  Better Body Bootcamp operates in full compliance with <strong className="text-gray-900">New York State General Business Law Article 30</strong>, which governs health club services and member rights. Under this law, you have the right to cancel if:
                </p>
                <ul className="space-y-2">
                  {[
                    'Within 3 business days of signing your agreement',
                    'You permanently relocate more than 25 miles from any location',
                    'You become permanently disabled',
                    'The facility closes or materially changes its services',
                  ].map((item) => (
                    <li key={item} className="flex gap-3 text-sm text-gray-500">
                      <span className="mt-1 w-1.5 h-1.5 bg-red-500 rounded-full flex-shrink-0" />
                      {item}
                    </li>
                  ))}
                </ul>
                <div className="border-t border-gray-200 pt-4 space-y-1">
                  <p className="text-sm font-black text-gray-900">Payment Security</p>
                  <p className="text-sm text-gray-500">All payments are processed via Stripe (PCI-DSS Level 1 certified). We do not store your full card number or CVV.</p>
                </div>
              </div>
            </div>
          </div>

          <div className="relative bg-gray-950 border border-red-900/40 rounded-2xl p-10 overflow-hidden">
            <div className="absolute top-0 right-0 w-64 h-64 bg-red-600/5 rounded-full translate-x-1/3 -translate-y-1/3" />
            <div className="absolute bottom-0 left-0 w-48 h-48 bg-red-600/5 rounded-full -translate-x-1/3 translate-y-1/3" />
            <div className="relative">
              <div className="inline-block bg-red-600/20 border border-red-600/40 text-red-400 text-xs font-bold px-3 py-1 rounded-full mb-4 tracking-widest uppercase">
                Need Help?
              </div>
              <h2 className="text-[clamp(1.5rem,4vw,3rem)] font-black text-white mb-3 tracking-tight">Have Legal Questions?</h2>
              <p className="text-gray-400 mb-8 max-w-xl text-sm leading-relaxed">
                If you have questions about any of our policies, your membership rights, or need help with a billing matter, our team is ready to assist.
              </p>
              <div className="flex flex-col sm:flex-row gap-3">
                <Link
                  to="/contact"
                  className="inline-block bg-red-600 hover:bg-red-700 text-white px-8 py-3 rounded-xl font-black transition-all hover:scale-105 text-center text-sm tracking-wide"
                >
                  Contact Us
                </Link>
                <a
                  href="mailto:info@betterbodybootcamp.com"
                  className="inline-block border border-gray-700 hover:border-red-600 text-gray-400 hover:text-white px-8 py-3 rounded-xl font-black transition-all text-center text-sm tracking-wide"
                >
                  Email Us Directly
                </a>
              </div>
              <p className="text-gray-700 text-xs mt-8">
                Better Body Bootcamp LLC &mdash; New York, NY &mdash; &copy; {new Date().getFullYear()} All rights reserved.
              </p>
            </div>
          </div>

        </div>
      </div>
    </div>
  );
}
