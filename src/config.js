// Clinic settings. Edit these and push to update the booking system.

export const CLINIC = {
  name: "Gemini Aesthetics",
  timezone: "Europe/London",
  stepMinutes: 15,      // how often start times are offered
  daysAhead: 60,        // how far ahead people can book
  holdMinutes: 30,      // how long a slot is held while someone pays
  currency: "gbp",
};

// Who works here (including anyone renting the room). Order matters:
// "Any practitioner" picks the first one who is free.
export const PRACTITIONERS = [
  { id: "lucy", name: "Lucy", role: "Senior Nurse Practitioner" },
  { id: "vic", name: "Vic", role: "Nurse Prescriber" },
  { id: "lottie", name: "Lottie", role: "Skin Specialist" },
];

// name must match the button text on the website.
// deposit is in pence (2500 = £25). who = practitioners who can do it.
export const TREATMENTS = [
  { name: "Consultation", mins: 30, deposit: 2500, who: ["lucy", "vic"] },
  { name: "Anti wrinkle injections", mins: 30, deposit: 2500, who: ["lucy", "vic"] },
  { name: "Dermal fillers", mins: 45, deposit: 2500, who: ["lucy"] },
  { name: "Skin boosters", mins: 45, deposit: 2500, who: ["lucy"] },
  { name: "Polynucleotides", mins: 45, deposit: 2500, who: ["lucy"] },
  { name: "Chemical peel", mins: 45, deposit: 2500, who: ["lottie"] },
  { name: "Microneedling", mins: 60, deposit: 2500, who: ["lottie", "lucy"] },
  { name: "Medical facial", mins: 60, deposit: 2500, who: ["lottie"] },
  { name: "Membership consultation", mins: 45, deposit: 2500, who: ["lucy"] },
  { name: "Skin consultation", mins: 20, deposit: 1000, who: ["lottie"] },
  { name: "Something else", mins: 30, deposit: 2500, who: ["lucy", "vic", "lottie"] },
];

// Opening hours, 24h "HH:MM". Index 0 = Sunday. null = closed.
export const HOURS = [
  null,                              // Sunday
  null,                              // Monday
  { open: "10:00", close: "18:00" }, // Tuesday
  { open: "10:00", close: "18:00" }, // Wednesday
  { open: "10:00", close: "20:00" }, // Thursday
  { open: "10:00", close: "18:00" }, // Friday
  { open: "09:00", close: "15:00" }, // Saturday
];
