import { useEffect, useState } from 'react';
import { supabase } from '../lib/supabase';
import PageHero, { Red } from '../components/PageHero';

interface TeamMember {
  id: string;
  name: string;
  title: string;
  bio: string;
  image_url: string | null;
  display_order: number;
}

export default function OurTeam() {
  const [teamMembers, setTeamMembers] = useState<TeamMember[]>([]);
  const [loading, setLoading] = useState(true);
  const [imageErrors, setImageErrors] = useState<Record<string, boolean>>({});

  useEffect(() => {
    fetchTeamMembers();
  }, []);

  const handleImageError = (memberId: string) => {
    setImageErrors(prev => ({ ...prev, [memberId]: true }));
  };

  const fetchTeamMembers = async () => {
    try {
      const { data, error } = await supabase
        .from('team_members')
        .select('*')
        .eq('is_active', true)
        .order('display_order');

      if (error) throw error;
      setTeamMembers(data || []);
    } catch (error) {
      console.error('Error fetching team members:', error);
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="min-h-screen bg-white">
      <PageHero
        eyebrow="COACHES & STAFF · NYC"
        lines={["MEET", <Red key="r">OUR TEAM</Red>]}
        sub="The trainers and staff who show up every day to get you to your goals."
      />

      <div className="container mx-auto px-4 py-16">
        {loading ? (
          <div className="text-center py-12">
            <p className="text-xl text-gray-600">Loading team members...</p>
          </div>
        ) : (
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-12">
            {teamMembers.map((member) => (
              <div
                key={member.id}
                className="bg-white rounded-xl shadow-lg overflow-hidden hover:shadow-2xl transition-all transform hover:-translate-y-2"
              >
                <div className="aspect-square bg-gradient-to-br from-red-600 to-red-800 flex items-center justify-center">
                  {member.image_url && !imageErrors[member.id] ? (
                    <img
                      src={member.image_url}
                      alt={member.name}
                      className="w-full h-full object-cover"
                      onError={() => handleImageError(member.id)}
                    />
                  ) : (
                    <div className="text-white text-6xl font-bold">
                      {member.name.split(' ').map(n => n[0]).join('')}
                    </div>
                  )}
                </div>
                <div className="p-6">
                  <h3 className="text-2xl font-bold mb-2 text-black">{member.name}</h3>
                  <p className="text-red-600 font-bold mb-2">{member.title}</p>
                  {/* 2026-06-30: Removed Mail/LinkedIn/Twitter buttons — they had
                      no onClick or href and the TeamMember interface has no
                      email/linkedin_url/twitter_url fields to wire them to.
                      Broken buttons on a trust page hurt more than no buttons. */}
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      <div className="bg-gray-50 py-16">
        <div className="container mx-auto px-4 text-center">
          <h2 className="text-[clamp(1.75rem,4vw,4rem)] font-bold mb-6 text-black">
            Join Our Team
          </h2>
          <p className="text-xl text-gray-700 mb-8 max-w-2xl mx-auto">
            We're always looking for passionate fitness professionals to join our family.
          </p>
          <a
            href="/careers"
            className="inline-block bg-red-600 hover:bg-red-700 text-white px-10 py-4 rounded-full text-lg font-bold transition-all transform hover:scale-105 shadow-lg"
          >
            View Open Positions
          </a>
        </div>
      </div>
    </div>
  );
}
