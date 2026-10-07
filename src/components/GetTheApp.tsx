// GetTheApp — the one place the app is pushed.
//
// 2026-10-07 (Justin): the schedule and booking flows keep working exactly as
// they do. This sits alongside them and pushes the app for checking times and
// reserving, because the app is where a member actually lives: push
// notifications, waitlist spot, one-tap rebooking, no login wall every visit.
//
// Deliberately NOT a replacement for the on-page widget. Someone who wants to
// book right now, on the page they are already on, should be able to. This is
// for the far more common second visit.
//
// Every link here carries data-track, so linkTracker records who clicked which
// store from which page, and once that person signs up the click joins back to
// them by visitor_id.

import { Smartphone, Bell, CalendarCheck, ExternalLink } from 'lucide-react';

const IOS = 'https://apps.apple.com/us/app/better-body-studios/id6778182425';
const ANDROID = 'https://play.google.com/store/apps/details?id=com.marianatek.betterbodybootcamp';

type Props = {
  /** Where this instance sits, so the click rows tell you which page sold it. */
  context: string;
  /** 'banner' sits above a widget. 'card' is a standalone block. */
  variant?: 'banner' | 'card';
  studioName?: string;
};

export default function GetTheApp({ context, variant = 'card', studioName }: Props) {
  const where = studioName ? `at ${studioName}` : '';

  if (variant === 'banner') {
    return (
      <div className="rounded-xl border border-red-100 bg-red-50/60 px-4 py-3 mb-5 flex flex-col sm:flex-row sm:items-center gap-3">
        <Smartphone className="w-5 h-5 text-red-600 shrink-0" />
        <p className="text-sm text-gray-800 flex-1 leading-snug">
          <strong className="font-bold">Book faster in the app.</strong>{' '}
          Live spot counts, waitlist alerts, and one tap to rebook your usual class.
        </p>
        <div className="flex items-center gap-3 shrink-0">
          <a href={IOS} target="_blank" rel="noopener"
             data-track={`app_ios_${context}`}
             className="text-sm font-bold text-red-700 hover:text-red-800 underline underline-offset-2">
            iPhone
          </a>
          <span className="text-gray-300">·</span>
          <a href={ANDROID} target="_blank" rel="noopener"
             data-track={`app_android_${context}`}
             className="text-sm font-bold text-red-700 hover:text-red-800 underline underline-offset-2 inline-flex items-center gap-1">
            Android <ExternalLink className="w-3 h-3" />
          </a>
        </div>
      </div>
    );
  }

  return (
    <div className="rounded-2xl border border-gray-200 bg-gradient-to-br from-gray-50 to-white p-6 sm:p-7">
      <div className="flex items-start gap-4">
        <div className="rounded-xl bg-red-600 p-2.5 shrink-0">
          <Smartphone className="w-5 h-5 text-white" />
        </div>
        <div className="min-w-0">
          <h3 className="text-lg font-bold text-black mb-1.5">
            Get the Better Body app
          </h3>
          <p className="text-sm text-gray-600 leading-relaxed mb-4">
            The schedule {where} lives in the app, and so does everything that
            makes booking quick. Check times without signing in each visit, grab
            a spot in two taps, and get told the moment a waitlist opens up.
          </p>

          <ul className="space-y-2 mb-5">
            <li className="flex items-center gap-2.5 text-sm text-gray-700">
              <CalendarCheck className="w-4 h-4 text-red-600 shrink-0" />
              This week's classes, with live spots left
            </li>
            <li className="flex items-center gap-2.5 text-sm text-gray-700">
              <Bell className="w-4 h-4 text-red-600 shrink-0" />
              Waitlist alerts, so you hear first when a place frees up
            </li>
            <li className="flex items-center gap-2.5 text-sm text-gray-700">
              <Smartphone className="w-4 h-4 text-red-600 shrink-0" />
              Rebook your usual class in one tap
            </li>
          </ul>

          <div className="flex flex-wrap gap-3">
            <a
              href={IOS} target="_blank" rel="noopener"
              data-track={`app_ios_${context}`}
              className="inline-flex items-center gap-2 bg-black hover:bg-gray-800 text-white font-bold text-sm px-5 py-2.5 rounded-full transition-colors"
            >
              Download for iPhone
            </a>
            <a
              href={ANDROID} target="_blank" rel="noopener"
              data-track={`app_android_${context}`}
              className="inline-flex items-center gap-2 bg-black hover:bg-gray-800 text-white font-bold text-sm px-5 py-2.5 rounded-full transition-colors"
            >
              Download for Android
            </a>
          </div>
          <p className="text-xs text-gray-400 mt-3">
            Already booking below? That keeps working. The app is just quicker next time.
          </p>
        </div>
      </div>
    </div>
  );
}
