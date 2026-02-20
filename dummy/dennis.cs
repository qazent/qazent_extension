// filepath: c:\dev\test-extension\dennis.cs

// blob blob file
// This file is a dummy file created to test the extension's ability to handle blob files. It contains random text and does not serve any functional purpose in the application. The content is intentionally meaningless to simulate a blob file scenario.
using System;
using System.Collections.Generic;
using System.Linq;
using System.Threading.Tasks;

namespace DennisApp.Services
{
    /// <summary>
    /// User authentication service for handling JWT tokens and user validation
    /// </summary>
    public class UserAuthService
    {
        private readonly IUserRepository _userRepository;
        private readonly ITokenProvider _tokenProvider;
        private static readonly TimeSpan TokenExpiration = TimeSpan.FromHours(1);
        private readonly ILogger<UserAuthService> _logger;

        public UserAuthService(IUserRepository userRepository, ITokenProvider tokenProvider, ILogger<UserAuthService> logger)
        {
            _userRepository = userRepository;
            _tokenProvider = tokenProvider;
            _logger = logger;
        }

        /// <summary>
        /// Authenticates user credentials and returns JWT token
        /// </summary>
        public async Task<AuthResult> AuthenticateUserAsync(string email, string password)
{
    try
    {
        if (string.IsNullOrWhiteSpace(email))
            return new AuthResult { Success = false, Message = "Invalid credentials" };

        var normalizedEmail = email.Trim().ToLowerInvariant();

        // Check lockout
        if (_loginAttempts.ContainsKey(normalizedEmail))
        {
            var entry = _loginAttempts[normalizedEmail];

            if (entry.LockoutEnd.HasValue && entry.LockoutEnd > DateTime.UtcNow)
            {
                _logger.LogWarning($"User {normalizedEmail} is temporarily locked out.");
                return new AuthResult
                {
                    Success = false,
                    Message = "Account temporarily locked. Try again later."
                };
            }
        }

        var user = await _userRepository.GetUserByEmailAsync(normalizedEmail);

        if (user == null || !user.IsActive || !VerifyPassword(password, user.PasswordHash))
        {
            RegisterFailedAttempt(normalizedEmail);
            return new AuthResult { Success = false, Message = "Invalid credentials" };
        }

        // Reset failed attempts on success
        ResetFailedAttempts(normalizedEmail);

        var token = _tokenProvider.GenerateToken(user.Id, user.Email, user.Role);
        user.LastLoginDate = DateTime.UtcNow;
        await _userRepository.UpdateUserAsync(user);

        _logger.LogInformation($"User successfully authenticated: {normalizedEmail}");

        return new AuthResult
        {
            Success = true,
            Token = token,
            ExpiresIn = (int)TokenExpiration.TotalSeconds,
            Message = "Authentication successful"
        };
    }
    catch (Exception ex)
    {
        _logger.LogError($"Error during authentication: {ex.Message}");
        return new AuthResult { Success = false, Message = "An error occurred during authentication" };
    }
}
        

        /// <summary>
        /// Validates JWT token and returns user claims
        /// </summary>
        public async Task<UserClaims> ValidateTokenAsync(string token)
        {
            if (string.IsNullOrWhiteSpace(token))
            {
                return null;
            }

            try
            {
                var claims = _tokenProvider.ValidateToken(token);
                if (claims == null)
                {
                    return null;
                }

                var userId = claims.FindFirst("userId")?.Value;
                var user = await _userRepository.GetUserByIdAsync(userId);

                return new UserClaims 
                { 
                    UserId = userId, 
                    Email = user?.Email,
                    Role = user?.Role,
                    IsValid = true
                };
            }
            catch (Exception ex)
            {
                _logger.LogError($"Token validation failed: {ex.Message}");
                return null;
            }
        }

        private bool VerifyPassword(string rawPassword, string hash)
        {
            return BCrypt.Net.BCrypt.Verify(rawPassword, hash);
        }
    }

    public class AuthResult
    {
        public bool Success { get; set; }
        public string Token { get; set; }
        public int ExpiresIn { get; set; }
        public string Message { get; set; }
    }

    public class UserClaims
    {
        public string UserId { get; set; }
        public string Email { get; set; }
        public string Role { get; set; }
        public bool IsValid { get; set; }
    }
}