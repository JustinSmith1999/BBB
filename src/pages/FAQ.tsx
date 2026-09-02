import { useState } from 'react';
import { ChevronDown, ChevronUp } from 'lucide-react';
import SEOHead from '../components/SEOHead';
import PageHero, { Red } from '../components/PageHero';

interface FAQItem {
  question: string;
  answer: string;
}

export default function FAQ() {
  const [openIndex, setOpenIndex] = useState<number | null>(0);

  const faqs: FAQItem[] = [
    {
      question: 'What is Better Body Bootcamp?',
      answer: 'Better Body Bootcamp is New York\'s premier group training program, offering high-intensity interval training combined with body sculpting exercises. Since 2011, we\'ve helped thousands of members achieve their fitness goals in a fun, supportive environment.',
    },
    {
      question: 'Do I need to be in shape to start?',
      answer: 'Not at all! Our program is designed for all fitness levels. Our expert trainers will modify exercises to match your current fitness level and help you progress at your own pace. Many of our most successful members started as complete beginners.',
    },
    {
      question: 'What should I bring to my first class?',
      answer: 'Bring a water bottle, a towel, and wear comfortable workout clothes and athletic shoes. We provide all necessary equipment. Arrive 10-15 minutes early for your first class so we can get you checked in and oriented.',
    },
    {
      question: 'How many times per week should I attend?',
      answer: 'For optimal results, we recommend attending 3-4 sessions per week. This frequency allows for proper recovery while maintaining consistency. However, you can attend as many or as few classes as your schedule allows with an unlimited membership.',
    },
    {
      question: 'What is the class size?',
      answer: 'Class sizes vary by location and time, but we typically have 15-25 members per session. This ensures you get personalized attention from trainers while enjoying the energy and motivation of group training.',
    },
    {
      question: 'Can I try a class before committing?',
      answer: 'Yes! We offer trial passes so you can experience our program firsthand. Contact us or fill out the trial signup form on our homepage to get started. We\'re confident you\'ll love it!',
    },
    {
      question: 'What makes Better Body different from other gyms?',
      answer: 'Unlike traditional gyms, we offer structured group training with expert coaches guiding every workout. You\'ll never wonder what to do - just show up and we\'ll push you to achieve results. Plus, our community atmosphere keeps you motivated and accountable.',
    },
    {
      question: 'Do you offer nutrition guidance?',
      answer: 'Yes! Members have access to nutrition guidance and resources to help maximize their results. We believe that fitness is 80% nutrition and 20% exercise, so we provide the support you need for complete transformation.',
    },
    {
      question: 'What is your cancellation policy?',
      answer: 'Classes can be cancelled up to 2 hours before the start time without penalty through the Better Body Studios app. Late cancellations may result in a fee. For membership cancellations, please refer to your membership agreement or contact your location directly.',
    },
    {
      question: 'Are there shower facilities?',
      answer: 'Shower availability varies by location. Please contact your preferred location directly for specific amenities. All locations have changing areas and lockers available.',
    },
    {
      question: 'Can I freeze my membership?',
      answer: 'Yes, we understand that life happens! Membership freezes are available under certain circumstances. Please contact your location or speak with a staff member to discuss your options and any applicable fees.',
    },
    {
      question: 'Do you offer corporate or group discounts?',
      answer: 'Yes! We offer special rates for corporate groups and multiple family members. Contact us to discuss group pricing options and how we can customize a program for your organization.',
    },
  ];

  const toggleFAQ = (index: number) => {
    setOpenIndex(openIndex === index ? null : index);
  };

  return (
    <>
    <SEOHead
      title="Frequently Asked Questions | Better Body Bootcamp"
      description="Everything you need to know about Better Body Bootcamp — classes, pricing, what to bring, membership options, and more."
      canonical="/faq"
      schema={{
        '@context': 'https://schema.org',
        '@type': 'FAQPage',
        mainEntity: [
          { '@type': 'Question', name: 'What is Better Body Bootcamp?', acceptedAnswer: { '@type': 'Answer', text: "Better Body Bootcamp is New York's premier group training program, offering high-intensity interval training combined with body sculpting exercises. Since 2011, we've helped thousands of members achieve their fitness goals across four NYC studios." } },
          { '@type': 'Question', name: 'Where are Better Body Bootcamp studios located?', acceptedAnswer: { '@type': 'Answer', text: 'Better Body Bootcamp has four New York City locations: Astoria (31-18 Steinway Street), Bayside (34-47 Bell Blvd), Fresh Meadows (76-46 164th Street) in Queens, and Williamsburg (487 Driggs Ave) in Brooklyn.' } },
          { '@type': 'Question', name: 'How much is the trial and what does it include?', acceptedAnswer: { '@type': 'Answer', text: 'New NYC customers can try two weeks of unlimited classes for $49. That is the only charge — there is no membership, no auto-renewal, and no commitment. After the trial you choose whether to continue.' } },
          { '@type': 'Question', name: 'Do I need to be in shape to start?', acceptedAnswer: { '@type': 'Answer', text: 'Not at all. The program is designed for all fitness levels and our coaches modify every exercise to match where you are. Many of our most successful members started as complete beginners.' } },
          { '@type': 'Question', name: 'What kinds of classes do you offer?', acceptedAnswer: { '@type': 'Answer', text: 'Coached group classes including HIIT, strength training, conditioning, bootcamp, Pilates, and hybrid strength-and-cardio sessions. Astoria also runs a 12-week competition training program.' } },
          { '@type': 'Question', name: 'Is Better Body Bootcamp good for beginners?', acceptedAnswer: { '@type': 'Answer', text: 'Yes. Every class is coach-led with scaled options, so first-timers work at their own pace alongside all levels. You never have to guess what to do — the coach guides the whole session.' } },
          { '@type': 'Question', name: 'How many times per week should I attend?', acceptedAnswer: { '@type': 'Answer', text: 'For best results we recommend 3-4 sessions per week, which balances consistency with recovery. With an unlimited membership you can attend as often as your schedule allows.' } },
          { '@type': 'Question', name: 'Can I try a class before committing?', acceptedAnswer: { '@type': 'Answer', text: 'Yes. Start with the $49 two-week unlimited trial to experience the program firsthand before deciding on a membership.' } },
          { '@type': 'Question', name: 'What is your cancellation policy?', acceptedAnswer: { '@type': 'Answer', text: 'Classes can be cancelled up to 2 hours before start time without penalty through the Better Body Studios app. Late cancellations may incur a fee. Membership cancellations follow your membership agreement — contact your home location.' } },
          { '@type': 'Question', name: 'Can I freeze my membership?', acceptedAnswer: { '@type': 'Answer', text: 'Membership freezes are available under certain circumstances — contact your location to discuss options and any applicable terms.' } },
        ],
      }}
    />
    <div className="min-h-screen bg-white">
      <PageHero
        eyebrow="GOOD QUESTIONS · NYC"
        lines={["YOUR QUESTIONS,", <Red key="r">ANSWERED</Red>]}
        sub="Everything you need to know about training at Better Body Bootcamp."
      />

      <div className="container mx-auto px-4 py-16">
        <div className="max-w-4xl mx-auto">
          {/* Visible intro (2026-08-23): the accordion answers are collapsed in the
              served HTML, so crawlers saw almost no text on this page. */}
          <div className="mb-10 text-gray-700 leading-relaxed space-y-4">
            <p>
              These are the questions we hear most at the front desk of our four studios in Astoria, Bayside,
              Fresh Meadows, and Williamsburg. The short version: every class is coach-led, small enough that the coach knows your name,
              and open to all fitness levels. New NYC customers start with the $49 two-week unlimited trial, and
              there is no contract trap behind it. It is a one-time charge with no auto-renewal.
            </p>
            <p>
              If your question is about a specific studio's schedule, amenities, or parking, the fastest answer
              is your studio's page or a quick text to the front desk. Everything else is covered below.
            </p>
          </div>
          <div className="space-y-4">
            {faqs.map((faq, index) => (
              <div
                key={index}
                className="bg-white border border-gray-200 rounded-xl shadow-md overflow-hidden hover:shadow-lg transition-shadow"
              >
                <button
                  onClick={() => toggleFAQ(index)}
                  className="w-full px-6 py-5 flex items-center justify-between text-left hover:bg-gray-50 transition-colors"
                >
                  <h3 className="text-lg font-bold text-black pr-8">{faq.question}</h3>
                  {openIndex === index ? (
                    <ChevronUp className="w-6 h-6 text-red-600 flex-shrink-0" />
                  ) : (
                    <ChevronDown className="w-6 h-6 text-gray-400 flex-shrink-0" />
                  )}
                </button>
                <div
                  className="overflow-hidden transition-all duration-300"
                  style={{ maxHeight: openIndex === index ? '400px' : '0px' }}
                  aria-hidden={openIndex !== index}
                >
                  <p className="px-6 pb-5 text-gray-700 leading-relaxed">{faq.answer}</p>
                </div>
              </div>
            ))}
          </div>
        </div>
      </div>

      <div className="bg-gradient-to-br from-red-600 to-red-800 text-white py-16">
        <div className="container mx-auto px-4 text-center">
          <h2 className="text-[clamp(1.75rem,4vw,4rem)] font-bold mb-6">
            Still Have Questions?
          </h2>
          <p className="text-xl mb-8 max-w-2xl mx-auto">
            Our team is here to help! Reach out and we'll get back to you as soon as possible.
          </p>
          <a
            href="/contact"
            className="inline-block bg-white text-red-600 hover:bg-gray-100 px-10 py-4 rounded-full text-lg font-bold transition-all transform hover:scale-105 shadow-lg"
          >
            Contact Us
          </a>
        </div>
      </div>
    </div>
    </>
  );
}
