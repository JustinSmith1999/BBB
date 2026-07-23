import { Dumbbell, Heart, Users, Zap, Mail } from 'lucide-react';
import SEOHead from '../components/SEOHead';

export default function Careers() {
  const benefits = [
    {
      icon: <Dumbbell className="w-12 h-12 text-red-600" />,
      title: 'Free Membership',
      description: 'Enjoy unlimited access to all Better Body Bootcamp locations',
    },
    {
      icon: <Heart className="w-12 h-12 text-red-600" />,
      title: 'Competitive Pay',
      description: 'Industry-leading compensation and performance bonuses',
    },
    {
      icon: <Users className="w-12 h-12 text-red-600" />,
      title: 'Amazing Community',
      description: 'Work with passionate people who share your fitness values',
    },
    {
      icon: <Zap className="w-12 h-12 text-red-600" />,
      title: 'Growth Opportunities',
      description: 'Advance your career with training and leadership opportunities',
    },
  ];

  const openings = [
    {
      title: 'Group Fitness Trainer',
      location: 'Multiple Locations',
      type: 'Full-Time / Part-Time',
      description:
        'Lead high-energy bootcamp classes and help members achieve their fitness goals. Must have group fitness certification and passion for motivating others.',
    },
    {
      title: 'Personal Trainer',
      location: 'Astoria, NY',
      type: 'Full-Time',
      description:
        'Provide one-on-one training sessions and personalized fitness plans. Requires personal training certification and 2+ years experience.',
    },
    {
      title: 'Front Desk Associate',
      location: 'Williamsburg, NY',
      type: 'Part-Time',
      description:
        'Be the first point of contact for members and guests. Handle check-ins, answer questions, and maintain a welcoming environment.',
    },
    {
      title: 'Social Media Manager',
      location: 'Remote',
      type: 'Contract',
      description:
        'Manage our social media presence, create engaging content, and build our online community. Experience with fitness industry preferred.',
    },
  ];

  return (
    <>
    <SEOHead
      title="Careers | Better Body Bootcamp"
      description="Join the Better Body Bootcamp team. We are hiring group fitness trainers, personal trainers, and front desk associates at our NYC locations."
      canonical="/careers"
    />
    <div className="min-h-screen bg-white">
      <div className="bg-gradient-to-br from-black to-gray-900 text-white pt-24 pb-20">
        <div className="container mx-auto px-4 text-center">
          <h1 className="text-[clamp(2rem,4.5vw,4rem)] font-bold mb-6">
            Join Our <span className="text-red-600">Team</span>
          </h1>
          <p className="text-xl md:text-2xl text-gray-300 max-w-3xl mx-auto">
            Help us transform lives while building a rewarding career in fitness
          </p>
        </div>
      </div>

      <div className="container mx-auto px-4 py-16">
        <div className="max-w-4xl mx-auto text-center mb-16">
          <h2 className="text-[clamp(2rem,4vw,4rem)] font-bold mb-6 text-black">Why Work With Us?</h2>
          <p className="text-xl text-gray-700 leading-relaxed">
            At Better Body Bootcamp, we're more than just a gym – we're a family. We invest in our
            team members and create an environment where you can thrive both personally and
            professionally.
          </p>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-8 mb-20">
          {benefits.map((benefit, index) => (
            <div
              key={index}
              className="text-center p-6 bg-white rounded-xl shadow-lg hover:shadow-2xl transition-all transform hover:-translate-y-2"
            >
              <div className="flex justify-center mb-4">{benefit.icon}</div>
              <h3 className="text-xl font-bold mb-3 text-black">{benefit.title}</h3>
              <p className="text-gray-700">{benefit.description}</p>
            </div>
          ))}
        </div>

        <div className="max-w-5xl mx-auto">
          <h2 className="text-[clamp(2rem,4vw,4rem)] font-bold mb-12 text-center text-black">Open Positions</h2>
          <div className="space-y-6">
            {openings.map((job, index) => (
              <div
                key={index}
                className="bg-white border border-gray-200 rounded-xl p-8 shadow-md hover:shadow-xl transition-all"
              >
                <div className="flex flex-col md:flex-row md:items-center md:justify-between mb-4">
                  <div>
                    <h3 className="text-2xl font-bold text-black mb-2">{job.title}</h3>
                    <div className="flex flex-wrap gap-3 text-sm text-gray-600">
                      <span className="bg-gray-100 px-3 py-1 rounded-full">{job.location}</span>
                      <span className="bg-red-100 text-red-700 px-3 py-1 rounded-full">
                        {job.type}
                      </span>
                    </div>
                  </div>
                  <button className="mt-4 md:mt-0 bg-red-600 hover:bg-red-700 text-white px-6 py-3 rounded-full font-bold transition-all transform hover:scale-105">
                    Apply Now
                  </button>
                </div>
                <p className="text-gray-700 leading-relaxed">{job.description}</p>
              </div>
            ))}
          </div>
        </div>
      </div>

      <div className="bg-gradient-to-br from-red-600 to-red-800 text-white py-16">
        <div className="container mx-auto px-4">
          <div className="max-w-4xl mx-auto text-center">
            <Mail className="w-16 h-16 mx-auto mb-6" />
            <h2 className="text-[clamp(1.75rem,4vw,4rem)] font-bold mb-6">
              Don't See the Right Position?
            </h2>
            <p className="text-xl mb-8">
              We're always looking for talented individuals to join our team. Send us your resume
              and we'll keep you in mind for future opportunities.
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
    </div>
    </>
  );
}
