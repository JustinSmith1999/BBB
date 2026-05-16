import { useEffect, useState } from 'react';
import { Mail, Linkedin, Twitter } from 'lucide-react';
import { supabase } from '../lib/supabase';

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
      <div className="bg-gradient-to-br from-black to-gray-900 text-white py-20 md:py-32 mt-20">
        <div className="container mx-auto px-4 text-center">
          <h1 className="text-5xl md:text-6xl lg:text-7xl font-bold mb-6 leading-tight">
            Meet <span className="text-red-600">Our Team</span>
          </h1>
          <p className="text-xl md:text-2xl text-gray-300 max-w-3xl mx-auto">
            Our passionate trainers and staff are dedicated to helping you achieve your fitness goals
          </p>
        </div>
      </div>

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
                  <p className="text-red-600 font-bold mb-4">{member.title}</p>
                  <div className="flex space-x-4">
                    <button className="text-gray-400 hover:text-red-600 transition-colors">
                      <Mail className="w-5 h-5" />
                    </button>
                    <button className="text-gray-400 hover:text-red-600 transition-colors">
                      <Linkedin className="w-5 h-5" />
                    </button>
                    <button className="text-gray-400 hover:text-red-600 transition-colors">
                      <Twitter className="w-5 h-5" />
                    </button>
                  </div>
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
