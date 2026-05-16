import { useState, useEffect } from 'react';
import { Calendar, Clock, MapPin, X } from 'lucide-react';
import { supabase, ClassBooking, Class, Location } from '../lib/supabase';

interface BookingWithDetails extends ClassBooking {
  class: Class;
  location: Location;
}

export default function MyBookings() {
  const [email, setEmail] = useState('');
  const [bookings, setBookings] = useState<BookingWithDetails[]>([]);
  const [loading, setLoading] = useState(false);
  const [searchPerformed, setSearchPerformed] = useState(false);

  const handleSearch = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!email) return;

    setLoading(true);
    setSearchPerformed(true);

    try {
      const { data: profile } = await supabase
        .from('user_profiles')
        .select('id')
        .eq('email', email)
        .maybeSingle();

      if (!profile) {
        setBookings([]);
        setLoading(false);
        return;
      }

      const { data: bookingsData } = await supabase
        .from('class_bookings')
        .select('*')
        .eq('user_profile_id', profile.id)
        .order('booked_at', { ascending: false });

      if (bookingsData) {
        const bookingsWithDetails = await Promise.all(
          bookingsData.map(async (booking) => {
            const { data: classData } = await supabase
              .from('classes')
              .select('*')
              .eq('id', booking.class_id)
              .single();

            const { data: locationData } = await supabase
              .from('locations')
              .select('*')
              .eq('id', classData.location_id)
              .single();

            return {
              ...booking,
              class: classData,
              location: locationData,
            };
          })
        );

        setBookings(bookingsWithDetails);
      }
    } catch (error) {
      console.error('Error fetching bookings:', error);
    } finally {
      setLoading(false);
    }
  };

  const handleCancelBooking = async (bookingId: string, classId: string) => {
    if (!confirm('Are you sure you want to cancel this booking?')) return;

    try {
      await supabase
        .from('class_bookings')
        .update({
          status: 'canceled',
          canceled_at: new Date().toISOString(),
        })
        .eq('id', bookingId);

      const booking = bookings.find(b => b.id === bookingId);
      if (booking) {
        await supabase
          .from('classes')
          .update({
            total_booked: Math.max(0, booking.class.total_booked - 1),
          })
          .eq('id', classId);
      }

      setBookings(bookings.filter(b => b.id !== bookingId));
    } catch (error) {
      console.error('Error canceling booking:', error);
      alert('Failed to cancel booking. Please try again.');
    }
  };

  const formatDateTime = (datetime: string) => {
    const date = new Date(datetime);
    return {
      date: date.toLocaleDateString('en-US', {
        weekday: 'short',
        month: 'short',
        day: 'numeric',
      }),
      time: date.toLocaleTimeString('en-US', {
        hour: 'numeric',
        minute: '2-digit',
        hour12: true,
      }),
    };
  };

  const upcomingBookings = bookings.filter(
    b => b.status === 'confirmed' && new Date(b.class.start_datetime) > new Date()
  );

  const pastBookings = bookings.filter(
    b => b.status === 'confirmed' && new Date(b.class.start_datetime) <= new Date()
  );

  return (
    <div className="min-h-screen bg-gray-50 pt-20">
      <div className="max-w-4xl mx-auto px-4 sm:px-6 lg:px-8 py-12">
        <div className="text-center mb-12">
          <h1 className="text-4xl font-bold text-gray-900 mb-4">My Bookings</h1>
          <p className="text-xl text-gray-600">
            View and manage your class bookings
          </p>
        </div>

        <div className="bg-white rounded-lg shadow-sm p-6 mb-8">
          <form onSubmit={handleSearch} className="flex gap-4">
            <input
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="Enter your email address"
              required
              className="flex-1 px-4 py-3 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-transparent"
            />
            <button
              type="submit"
              disabled={loading}
              className="px-6 py-3 bg-blue-600 text-white rounded-lg font-semibold hover:bg-blue-700 transition-colors disabled:bg-gray-400 disabled:cursor-not-allowed"
            >
              {loading ? 'Searching...' : 'Find Bookings'}
            </button>
          </form>
        </div>

        {searchPerformed && !loading && (
          <>
            {upcomingBookings.length > 0 && (
              <div className="mb-8">
                <h2 className="text-2xl font-bold text-gray-900 mb-4">Upcoming Classes</h2>
                <div className="space-y-4">
                  {upcomingBookings.map((booking) => {
                    const { date, time } = formatDateTime(booking.class.start_datetime);
                    return (
                      <div
                        key={booking.id}
                        className="bg-white rounded-lg shadow-sm p-6 hover:shadow-md transition-shadow"
                      >
                        <div className="flex items-start justify-between">
                          <div className="flex-1">
                            <h3 className="text-xl font-bold text-gray-900 mb-3">
                              {booking.class.name}
                            </h3>

                            <div className="space-y-2">
                              <div className="flex items-center text-sm text-gray-600">
                                <Calendar className="w-4 h-4 mr-2" />
                                {date}
                              </div>

                              <div className="flex items-center text-sm text-gray-600">
                                <Clock className="w-4 h-4 mr-2" />
                                {time}
                              </div>

                              <div className="flex items-center text-sm text-gray-600">
                                <MapPin className="w-4 h-4 mr-2" />
                                {booking.location.name}
                              </div>
                            </div>

                            <div className="mt-4">
                              <span
                                className={`inline-block px-3 py-1 rounded-full text-sm font-semibold ${
                                  booking.status === 'confirmed'
                                    ? 'bg-green-100 text-green-800'
                                    : 'bg-yellow-100 text-yellow-800'
                                }`}
                              >
                                {booking.status.charAt(0).toUpperCase() + booking.status.slice(1)}
                              </span>
                            </div>
                          </div>

                          <button
                            onClick={() => handleCancelBooking(booking.id, booking.class.id)}
                            className="ml-4 p-2 text-red-600 hover:bg-red-50 rounded-lg transition-colors"
                            title="Cancel booking"
                          >
                            <X className="w-5 h-5" />
                          </button>
                        </div>
                      </div>
                    );
                  })}
                </div>
              </div>
            )}

            {pastBookings.length > 0 && (
              <div className="mb-8">
                <h2 className="text-2xl font-bold text-gray-900 mb-4">Past Classes</h2>
                <div className="space-y-4">
                  {pastBookings.map((booking) => {
                    const { date, time } = formatDateTime(booking.class.start_datetime);
                    return (
                      <div
                        key={booking.id}
                        className="bg-white rounded-lg shadow-sm p-6 opacity-75"
                      >
                        <div className="flex items-start justify-between">
                          <div className="flex-1">
                            <h3 className="text-xl font-bold text-gray-900 mb-3">
                              {booking.class.name}
                            </h3>

                            <div className="space-y-2">
                              <div className="flex items-center text-sm text-gray-600">
                                <Calendar className="w-4 h-4 mr-2" />
                                {date}
                              </div>

                              <div className="flex items-center text-sm text-gray-600">
                                <Clock className="w-4 h-4 mr-2" />
                                {time}
                              </div>

                              <div className="flex items-center text-sm text-gray-600">
                                <MapPin className="w-4 h-4 mr-2" />
                                {booking.location.name}
                              </div>
                            </div>
                          </div>
                        </div>
                      </div>
                    );
                  })}
                </div>
              </div>
            )}

            {bookings.length === 0 && (
              <div className="text-center py-12">
                <Calendar className="w-16 h-16 text-gray-400 mx-auto mb-4" />
                <h3 className="text-xl font-semibold text-gray-900 mb-2">No bookings found</h3>
                <p className="text-gray-600 mb-6">
                  We couldn't find any bookings for this email address.
                </p>
                <a
                  href="/classes"
                  className="inline-block px-6 py-3 bg-blue-600 text-white rounded-lg font-semibold hover:bg-blue-700 transition-colors"
                >
                  Browse Classes
                </a>
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}
